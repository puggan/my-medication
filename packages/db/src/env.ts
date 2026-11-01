import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// In development the repo's .env; a deployed server gets its variables from systemd instead
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name} in .env`);
    return value;
}

export const dbCredentials = {
    host: required('DB_HOST'),
    port: Number(required('DB_PORT')),
    user: required('DB_USERNAME'),
    password: required('DB_PASSWORD'),
    database: required('DB_DATABASE'),
};
