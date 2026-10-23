import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/sqlite/schema.ts',
  out: './drizzle',
});
