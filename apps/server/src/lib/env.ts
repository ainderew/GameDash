import { z } from 'zod';

/**
 * Validated server environment. Parsed lazily so tooling (typecheck/build) works
 * without a populated `.env`; the first real access (DB, auth) enforces presence.
 */
const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | null = null;

export const getEnv = (): ServerEnv => {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `Invalid/missing server env: ${missing}. Copy apps/server/.env.example → .env and fill it in.`,
    );
  }
  cached = parsed.data;
  return cached;
};
