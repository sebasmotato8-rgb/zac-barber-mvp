import Groq from 'groq-sdk';
import { env } from '../../config/env';
import { BARBER_TOOLS } from './tools';
import { ToolExecutor } from './tool-executor';
import { logger } from '../../config/logger';
import type { DbClient } from '../../integrations/supabase/client';
import type { Service } from '../../types/database';
import { ServicesRepository } from '../../repositories/services.repository';
import { BusinessConfigRepository } from '../../repositories/schedules.repository';

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentInput {
  shopId: string;
  userMessage: string;
  conversationId?: string;
  messageHistory: ChatMessage[];
  db: DbClient;
}

export interface AgentOutput {
  reply: string;
  conversationId?: string;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: string[];
  escalated: boolean;
}

const promptCache = new Map<string, { prompt: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function buildSystemPrompt(
  shopId: string,
  db: DbClient
): Promise<string> {
  const cached = promptCache.get(shopId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.prompt;
  }

  const servicesRepo = new ServicesRepository(db);
  const configRepo = new BusinessConfigRepository(db);

  const [services, config, shopRow, barbersRow] = await Promise.all([
    servicesRepo.findAll(shopId, true),
    configRepo.getMap(shopId),
    db.from('barber_shops').select('name, address, city, phone, timezone').eq('id', shopId).single(),
    db.from('users').select('id, full_name, bio').eq('shop_id', shopId).eq('role', 'barber').eq('is_active', true),
  ]);

  const shop = shopRow.data;
  const today = new Date().toLocaleDateString('es-CO', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: shop?.timezone ?? 'America/Bogota',
  });

  const servicesCatalog = (services as Service[])
    .map((s) => `- ${s.name} [${s.id}]: $${s.price.toLocaleString('es-CO')} ${s.duration_minutes}min`)
    .join('\n');

  const barbersList = (barbersRow.data ?? [])
    .map((b) => `- ${b.full_name} [${b.id}]`)
    .join('\n');

  const prompt = `Eres el asistente virtual de Zac Barber.
Ayudas a reservar, cancelar y reagendar citas.

NEGOCIO: ${shop?.name ?? 'Zac Barber'} | ${shop?.address ?? ''}, ${shop?.city ?? ''} | Tel: ${shop?.phone ?? ''}
Hoy: ${today}

SERVICIOS
${servicesCatalog || '(Sin servicios)'}

BARBEROS
${barbersList || '(Sin barberos)'}

REGLAS
1. Sé amable, conciso. Máximo 3 oraciones.
2. Llama tools directamente, nunca pidas permiso.
3. Para reservar necesitas: nombre, teléfono, servicio, barbero, fecha/hora.
4. Antes de crear cita, llama get_availability.
5. Para cancelar/reagendar, usa find_client_appointments con el teléfono.
6. Sin preferencia de barbero, sugiere el primero.
7. NUNCA inventes datos. Usa solo este prompt o resultados de tools.
8. Responde en español colombiano informal y respetuoso.
9. Si no puedes resolver en 3 intentos, usa escalate_to_human.

CONFIG: Min anticipación ${config['booking.min_advance_minutes'] ?? '60'}min | Max ${config['booking.max_advance_days'] ?? '30'} días | Slots ${config['booking.slot_duration_minutes'] ?? '30'}min`;

  promptCache.set(shopId, { prompt, expiresAt: Date.now() + CACHE_TTL_MS });
  return prompt;
}

async function callGroqWithRetry(
  params: Parameters<typeof groq.chat.completions.create>[0],
  maxRetries: number = 2
): Promise<Groq.Chat.ChatCompletion> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await groq.chat.completions.create(params) as Groq.Chat.ChatCompletion;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;

      if (status === 429 && attempt < maxRetries) {
        const delayMs = (attempt + 1) * 2000;
        logger.warn({ attempt, delayMs }, 'Groq 429, retrying after delay');
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      throw err;
    }
  }
  throw new Error('Unreachable');
}

export async function runBarberAgent(input: AgentInput): Promise<AgentOutput> {
  const { shopId, userMessage, messageHistory, db, conversationId } = input;

  const executor = new ToolExecutor(db, shopId, conversationId);
  const systemPrompt = await buildSystemPrompt(shopId, db);

  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messageHistory.map((m): Groq.Chat.ChatCompletionMessageParam => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const toolsUsed: string[] = [];
  let escalated = false;
  let finalReply = '';
  let lastPartialContent = '';
  let iterations = 0;

  while (iterations < env.GROQ_MAX_ITERATIONS) {
    iterations++;

    let completion: Groq.Chat.ChatCompletion;
    try {
      completion = await callGroqWithRetry({
        model: env.GROQ_MODEL,
        messages,
        tools: BARBER_TOOLS,
        tool_choice: 'auto',
        max_tokens: env.GROQ_MAX_TOKENS,
        temperature: 0.3,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429) {
        logger.warn({ shopId }, 'Groq rate limit exceeded after retries');
        finalReply = lastPartialContent || 'Tenemos mucha demanda en este momento. Intenta de nuevo en un minuto. 🙏';
        break;
      }
      if (status === 400) {
        logger.warn({ shopId, iterations }, 'Groq 400, retrying without tools');
        try {
          const fallback = await callGroqWithRetry({
            model: env.GROQ_MODEL,
            messages,
            max_tokens: env.GROQ_MAX_TOKENS,
            temperature: 0.3,
          });
          finalReply = (fallback.choices[0]?.message?.content ?? '').trim();
          const usage = fallback.usage;
          if (usage) {
            totalInputTokens += usage.prompt_tokens ?? 0;
            totalOutputTokens += usage.completion_tokens ?? 0;
          }
        } catch {
          finalReply = lastPartialContent || 'Tuve un problema procesando tu solicitud. ¿Puedes intentarlo de nuevo?';
        }
        break;
      }
      throw err;
    }

    const usage = completion.usage;
    if (usage) {
      totalInputTokens += usage.prompt_tokens ?? 0;
      totalOutputTokens += usage.completion_tokens ?? 0;
    }

    const choice = completion.choices[0];
    if (!choice) {
      logger.warn({ shopId, iterations }, 'Groq no devolvió opciones');
      break;
    }

    const assistantMsg = choice.message;
    const toolCalls = assistantMsg.tool_calls;

    if (assistantMsg.content) {
      lastPartialContent = assistantMsg.content.trim();
    }

    messages.push({
      role: 'assistant',
      content: assistantMsg.content ?? '',
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (!toolCalls || toolCalls.length === 0) {
      finalReply = (assistantMsg.content ?? '').trim();
      break;
    }

    logger.debug(
      { iterations, shopId, toolCalls: toolCalls.length },
      'Iteración del agente Groq'
    );

    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      toolsUsed.push(name);

      if (name === 'escalate_to_human') escalated = true;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
        logger.warn({ toolName: name, raw: toolCall.function.arguments }, 'Failed to parse tool args');
      }

      const toolResult = await executor.execute(name, args);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  if (!finalReply) {
    finalReply = lastPartialContent || 'Lo siento, tuve un problema procesando tu solicitud. ¿Puedes intentarlo de nuevo?';
  }

  return {
    reply: finalReply,
    conversationId,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolsUsed,
    escalated,
  };
}
