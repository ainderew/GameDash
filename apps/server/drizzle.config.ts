import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Migrations run over the session-mode pooler (DIRECT_URL, 5432); the app runtime
// uses the transaction pooler (DATABASE_URL, 6543).
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: '../../packages/shared/src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
