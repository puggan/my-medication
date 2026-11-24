import { and, asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { trust, user, type Db, type Tx, type User } from '@med/db';

export async function listUsers(db: Db): Promise<User[]> {
    return db.select().from(user).orderBy(asc(user.id));
}

export async function addUser(tx: Tx, name: string): Promise<void> {
    if (!/^[a-z0-9._-]{1,64}$/.test(name)) throw new Error('A user name is lower-case letters, digits, . _ or -');
    const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.name, name));
    if (existing) throw new Error(`A user named "${name}" already exists`);
    await tx.insert(user).values({ name });
}

const giver = alias(user, 'giver');
const trusted = alias(user, 'trusted');

/** Who may see and act for whom. */
export async function listTrust(db: Db): Promise<{ giver: string; trusted: string; since: string }[]> {
    return db
        .select({ giver: giver.name, trusted: trusted.name, since: trust.createdAt })
        .from(trust)
        .innerJoin(giver, eq(giver.id, trust.giverId))
        .innerJoin(trusted, eq(trusted.id, trust.trustedId))
        .orderBy(asc(giver.name), asc(trusted.name));
}

export async function addTrust(tx: Tx, from: User, to: User): Promise<void> {
    if (from.id === to.id) throw new Error('A user always sees their own medications');
    const [existing] = await tx
        .select({ id: trust.id })
        .from(trust)
        .where(and(eq(trust.giverId, from.id), eq(trust.trustedId, to.id)));
    if (existing) throw new Error(`${to.name} already has ${from.name}'s trust`);
    await tx.insert(trust).values({ giverId: from.id, trustedId: to.id });
}

export async function removeTrust(tx: Tx, from: User, to: User): Promise<void> {
    const [existing] = await tx
        .select({ id: trust.id })
        .from(trust)
        .where(and(eq(trust.giverId, from.id), eq(trust.trustedId, to.id)));
    if (!existing) throw new Error(`${to.name} doesn't have ${from.name}'s trust`);
    await tx.delete(trust).where(eq(trust.id, existing.id));
}
