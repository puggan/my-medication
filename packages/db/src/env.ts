import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

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
