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

function getDateContext(tz: string): string {
  const now = new Date();
  const fmt = (d: Date) => d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
  const iso = (d: Date) => {
    const parts = d.toLocaleDateString('en-CA', { timeZone: tz }).split('/');
    return parts.join('-');
  };
  const tomorrow = new Date(now.getTime() + 86400000);
  const dayAfter = new Date(now.getTime() + 2 * 86400000);

  const daysUntilSat = (6 - now.getDay() + 7) % 7 || 7;
  const saturday = new Date(now.getTime() + daysUntilSat * 86400000);

  return `Hoy: ${fmt(now)} (${iso(now)})
Mañana: ${fmt(tomorrow)} (${iso(tomorrow)})
Pasado mañana: ${fmt(dayAfter)} (${iso(dayAfter)})
Este sábado: ${iso(saturday)}
Zona horaria: ${tz} (offset -05:00)`;
}

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
  const tz = shop?.timezone ?? 'America/Bogota';
  const dateCtx = getDateContext(tz);

  const servicesCatalog = (services as Service[])
    .map((s) => `- ${s.name} [${s.id}]: $${s.price.toLocaleString('es-CO')} ${s.duration_minutes}min`)
    .join('\n');

  const barbers = barbersRow.data ?? [];
  const barbersList = barbers
    .map((b) => `- ${b.full_name} [${b.id}]`)
    .join('\n');

  const firstBarberId = barbers[0]?.id ?? '';
  const firstBarberName = barbers[0]?.full_name ?? '';

  const shopName = shop?.name ?? 'la barbería';

  const prompt = `Eres el asistente virtual de ${shopName}. Tu nombre es Asistente de ${shopName}.
Ayudas a reservar, cancelar y reagendar citas de barbería.

NEGOCIO
Nombre: ${shopName}
Dirección: ${shop?.address ?? ''}, ${shop?.city ?? ''}
Teléfono: ${shop?.phone ?? ''}

FECHA Y HORA ACTUAL
${dateCtx}

SERVICIOS DISPONIBLES
${servicesCatalog || '(Sin servicios configurados)'}

BARBEROS DISPONIBLES
${barbersList || '(Sin barberos configurados)'}
Barbero por defecto (cuando digan "cualquiera", "el que esté", "el primero"): ${firstBarberName} [${firstBarberId}]

INSTRUCCIONES PARA INTERPRETAR FECHAS Y HORAS
- "mañana" = usa la fecha de mañana indicada arriba
- "hoy" = usa la fecha de hoy indicada arriba
- "este sábado" = usa la fecha del sábado indicada arriba
- "a las 8", "8am", "8 de la mañana" = 08:00
- "a las 2", "2pm", "2 de la tarde" = 14:00
- "a primera hora", "temprano" = 09:00
- "después de las 5" = busca disponibilidad desde las 17:00
- Formato ISO para scheduled_at: YYYY-MM-DDThh:mm:00-05:00

INTERPRETACIÓN DE HORARIOS DEL USUARIO (MUY IMPORTANTE)
Cuando el usuario responde con un horario, interpreta así:
- "930", "9 30", "9:30", "09:30", "930am" → 09:30
- "1030", "10 30", "10:30" → 10:30
- "2pm", "200", "2:00" → 14:00
- "130", "1:30", "130pm" → 13:30
Si ya ofreciste horarios disponibles y el usuario elige uno, NO vuelvas a llamar get_availability. Usa directamente el slot que el usuario eligió para llamar book_appointment.
Solo vuelve a verificar disponibilidad si el usuario pide un horario DIFERENTE a los que ofreciste.

INSTRUCCIONES PARA BARBEROS
- "cualquier barbero", "el que esté", "con cualquiera", "no importa", "el primero disponible" → usa ${firstBarberName} [${firstBarberId}]
- Si el cliente nombra un barbero específico, usa ese

FORMATO DE RESPUESTA (MUY IMPORTANTE)
SIEMPRE usa listas numeradas para que el usuario elija. Ejemplos:

Para servicios:
"¿Qué servicio deseas?
1. Corte clásico — $25.000
2. Corte + barba — $38.000
3. Afeitado clásico — $20.000
..."

Para horarios (después de llamar get_availability):
"Horarios disponibles para [fecha]:
1. 9:00 a.m.
2. 9:30 a.m.
3. 10:00 a.m.
..."

Para barberos:
"¿Con quién prefieres?
1. [nombre barbero 1]
2. [nombre barbero 2]
3. Cualquiera disponible"

Para confirmaciones:
"1. Sí, confirmar
2. No, cambiar algo"

INTERPRETACIÓN DE RESPUESTAS NUMERADAS
Cuando el usuario responde "1", "01", "opción 1", "la 1", "el primero", "numero 1" → selecciona la opción 1 de tu última lista.
Cuando responde "2", "02", "la segunda" → opción 2. Y así sucesivamente.
Si la respuesta no coincide con ninguna opción, muestra las opciones nuevamente sin error.

REGLAS
1. Responde siempre en español, amable y conciso.
2. Llama las tools directamente. NUNCA menciones tools, IDs, funciones ni JSON al usuario.
3. Para reservar necesitas: nombre completo, teléfono, servicio, barbero, fecha/hora. Pregunta lo que falte usando opciones numeradas.
4. Antes de crear cita SIEMPRE llama get_availability.
5. "cualquier barbero", "el que esté", "con cualquiera" → usa el barbero por defecto.
6. NUNCA inventes horarios ni precios. Solo datos de tools o de este prompt.
7. Si una tool falla, di "No encontré opciones para esa fecha. ¿Quieres probar con otra?" NUNCA digas "ocurrió un error".
8. Cuando muestres horarios del resultado de get_availability, numéralos. Cuando el usuario elija un número, usa el slot correspondiente SIN volver a llamar get_availability.

PREVENCIÓN DE DUPLICADOS
Antes de book_appointment, SIEMPRE llama check_existing_appointment.
Si has_active es true: "Ya tienes una cita para [fecha]. ¿Qué deseas hacer?\n1. Reagendar\n2. Cancelar\n3. Mantener la cita actual"

REAGENDAMIENTO
Cuando diga "reagendar", "cambiar cita", "mover cita":
1. Pide teléfono → llama find_client_appointments.
2. Muestra cita encontrada: "Encontré tu cita:\n[servicio] — [fecha hora]\n\n1. Reagendar\n2. Cancelar\n3. Mantener"
3. Si elige reagendar → pide nueva fecha → get_availability → muestra opciones numeradas → reschedule_appointment.

RESERVAS MÚLTIPLES
Si dice "somos dos", "dos cortes", "para dos personas":
1. Pide nombre y teléfono de cada uno.
2. Crea citas en slots consecutivos.
3. Confirma ambas al final.

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

const FRIENDLY_ERRORS = [
  'Disculpa, no pude procesar tu solicitud. ¿Podrías intentarlo de nuevo? 🙏',
  'Ups, algo salió mal. ¿Puedes repetir lo que necesitas?',
  'Tuve un inconveniente. ¿Me lo dices de otra forma?',
];

function friendlyError(): string {
  return FRIENDLY_ERRORS[Math.floor(Math.random() * FRIENDLY_ERRORS.length)];
}

export async function runBarberAgent(input: AgentInput): Promise<AgentOutput> {
  const { shopId, userMessage, messageHistory, db, conversationId } = input;

  const executor = new ToolExecutor(db, shopId, conversationId);

  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemPrompt(shopId, db);
  } catch (err) {
    logger.error({ err, shopId }, 'Failed to build system prompt');
    return {
      reply: friendlyError(),
      conversationId,
      inputTokens: 0, outputTokens: 0,
      toolsUsed: [], escalated: false,
    };
  }

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

  try {
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
          logger.warn({ shopId }, 'Groq rate limit after retries');
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
            const u = fallback.usage;
            if (u) { totalInputTokens += u.prompt_tokens ?? 0; totalOutputTokens += u.completion_tokens ?? 0; }
          } catch {
            finalReply = lastPartialContent || friendlyError();
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
      if (!choice) { break; }

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

      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;
        toolsUsed.push(name);
        if (name === 'escalate_to_human') escalated = true;

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
          logger.warn({ toolName: name, raw: toolCall.function.arguments }, 'Bad tool args');
        }

        let toolResult;
        try {
          toolResult = await executor.execute(name, args);
        } catch (toolErr) {
          logger.warn({ toolName: name, err: toolErr }, 'Tool execution failed');
          toolResult = { success: false, error: 'No se pudo completar la operación. Intenta con otros datos.' };
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }
    }
  } catch (err) {
    logger.error({ err, shopId, iterations }, 'Agent loop failed');
    finalReply = lastPartialContent || friendlyError();
  }

  if (!finalReply) {
    finalReply = lastPartialContent || friendlyError();
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
