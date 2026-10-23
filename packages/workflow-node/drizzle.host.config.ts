import { defineConfig } from 'drizzle-kit';

/** Host tables (workflow library, workspaces); generate with `pnpm run db:generate:host`. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/host/schema.ts',
  out: './drizzle-host',
});
