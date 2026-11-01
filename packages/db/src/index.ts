import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { createPool } from 'mysql2/promise';
import { dbCredentials } from './env.ts';
import * as schema from './schema.ts';

export * from './schema.ts';

export function connect() {
    return drizzle({ client: createPool(dbCredentials), schema, mode: 'default', casing: 'snake_case' });
}

export type Db = ReturnType<typeof connect>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Connect and run SELECT 1, so scripts fail fast before doing any other work. */
export async function connectVerified(): Promise<Db> {
    const db = connect();
    try {
        await db.execute(sql`SELECT 1`);
    } catch (error) {
        await db.$client.end().catch(() => {});
        let root = error as Error & { code?: string };
        while (root.cause instanceof Error) root = root.cause;
        const { host, port, database } = dbCredentials;
        const hint = root.code === 'ECONNREFUSED' ? ' (is ./db-tunnel.sh running?)' : '';
        throw new Error(`No database connection to ${database} at ${host}:${port}${hint}: ${root.message}`, {
            cause: error,
        });
    }
    return db;
}
