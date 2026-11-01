import { defineConfig } from 'drizzle-kit';
import { dbCredentials } from './src/env.ts';

export default defineConfig({
    dialect: 'mysql',
    schema: './src/schema.ts',
    out: './migrations',
    casing: 'snake_case',
    dbCredentials,
});
