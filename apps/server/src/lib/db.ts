import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@shared/schema';
import { getEnv } from '@/lib/env';

/**
 * The Drizzle DB client, created lazily on first use so importing this module
 * never forces env validation (keeps tooling happy without a live `.env`).
 */
let client: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export const getDb = () => {
  if (dbInstance) return dbInstance;
  const { DATABASE_URL } = getEnv();
  // prepare:false is required for Supabase's transaction-mode pooler (pgbouncer).
  client = postgres(DATABASE_URL, { prepare: false });
  dbInstance = drizzle(client, { schema });
  return dbInstance;
};

export type Db = ReturnType<typeof getDb>;

/** A transaction handle — what services pass to repositories so ops compose atomically. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export { schema };
