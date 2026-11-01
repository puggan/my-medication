import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { passkey, user, type Db, type Passkey, type Tx, type User } from '@med/db';

export type PasskeyRow = Passkey & { userName: string | null };

export async function listPasskeys(db: Db): Promise<PasskeyRow[]> {
    const rows = await db
        .select({ passkey, userName: user.name })
        .from(passkey)
        .leftJoin(user, eq(user.id, passkey.userId))
        .orderBy(desc(passkey.createdAt));
    return rows.map((row) => ({ ...row.passkey, userName: row.userName }));
}

export function passkeyState(key: Passkey): 'revoked' | 'approved' | 'pending' {
    return key.revokedAt !== null ? 'revoked' : key.approvedAt !== null ? 'approved' : 'pending';
}

/** Pairing codes are shown as K7Q-3FX; accept them with or without the dash, in any case. */
export function normalizeCode(code: string): string {
    return code.replace(/-/g, '').toUpperCase();
}

/** Connect the pending passkey showing code to owner and approve it, optionally naming it. */
export async function approvePasskey(tx: Tx, code: string, owner: User, name?: string): Promise<Passkey> {
    const pending = await tx
        .select()
        .from(passkey)
        .where(and(eq(passkey.pairingCode, normalizeCode(code)), isNull(passkey.approvedAt), isNull(passkey.revokedAt)));
    if (pending.length === 0) throw new Error(`No pending passkey with code ${code}`);
    if (pending.length > 1) throw new Error(`${pending.length} pending passkeys show code ${code}; revoke the extra ones by id`);
    const key = pending[0]!;
    await tx
        .update(passkey)
        .set({ userId: owner.id, approvedAt: sql`CURRENT_TIMESTAMP`, ...(name === undefined ? {} : { name }) })
        .where(eq(passkey.id, key.id));
    return key;
}

/** The one unrevoked passkey with this id or pairing code. */
async function findPasskey(tx: Tx, idOrCode: string): Promise<Passkey> {
    const where = /^\d+$/.test(idOrCode)
        ? eq(passkey.id, Number(idOrCode))
        : eq(passkey.pairingCode, normalizeCode(idOrCode));
    const keys = await tx.select().from(passkey).where(and(where, isNull(passkey.revokedAt)));
    if (keys.length !== 1) throw new Error(`${keys.length} unrevoked passkeys match ${idOrCode}; use the id`);
    return keys[0]!;
}

/** Revoke by id or pairing code; a revoked key can never log in again. */
export async function revokePasskey(tx: Tx, idOrCode: string): Promise<Passkey> {
    const key = await findPasskey(tx, idOrCode);
    await tx.update(passkey).set({ revokedAt: sql`CURRENT_TIMESTAMP` }).where(eq(passkey.id, key.id));
    return key;
}

/** Name a passkey by id or pairing code; an empty name removes it. */
export async function namePasskey(tx: Tx, idOrCode: string, name: string): Promise<Passkey> {
    const trimmed = name.trim();
    if (trimmed.length > 64) throw new Error('A passkey name is at most 64 characters');
    const key = await findPasskey(tx, idOrCode);
    await tx.update(passkey).set({ name: trimmed === '' ? null : trimmed }).where(eq(passkey.id, key.id));
    return key;
}

/** The name if set, else the browser and OS. */
export function describePasskey(key: Passkey): string {
    return key.name === null ? key.label : `${key.name} (${key.label})`;
}

export function formatCode(code: string): string {
    return `${code.slice(0, 3)}-${code.slice(3)}`;
}
