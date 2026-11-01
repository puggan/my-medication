import '@med/db';

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name} in the environment`);
    return value;
}

/** Where browsers reach the app; passkeys are bound to its host name. */
export const origin = required('WEB_ORIGIN').replace(/\/$/, '');
export const rpID = new URL(origin).hostname;
export const secure = origin.startsWith('https:');
export const port = Number(process.env.WEB_PORT ?? 3100);
/** Signs the session and challenge cookies; at least 32 random characters. */
export const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
/** Built client files, next to the server bundle when deployed. */
export const publicDir = process.env.WEB_PUBLIC_DIR ?? 'dist/public';
