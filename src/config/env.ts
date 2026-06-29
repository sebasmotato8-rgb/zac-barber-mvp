import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default('/api/v1'),

  SUPABASE_URL: z.string().url('SUPABASE_URL debe ser una URL válida'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY requerida'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY requerida'),

  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY requerida'),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_MAX_TOKENS: z.coerce.number().default(1024),
  GROQ_MAX_ITERATIONS: z.coerce.number().default(8),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  AI_RATE_LIMIT_MAX: z.coerce.number().default(20),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── Chargly E-commerce ─────────────────────────────
  PAYPAL_CLIENT_ID: z.string().default(''),
  PAYPAL_CLIENT_SECRET: z.string().default(''),
  PAYPAL_WEBHOOK_ID: z.string().default(''),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('live'),

  CJ_API_KEY: z.string().default(''),
  CJ_PRODUCT_VID: z.string().default('1533362500308316160'),

  RESEND_API_KEY: z.string().default(''),

  ADMIN_PASSWORD: z.string().default('chargly2026'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
