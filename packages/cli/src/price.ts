import { asc, eq } from 'drizzle-orm';
import { medication, price, type Db, type Price, type User } from '@med/db';

/** A user's price history, oldest first, optionally for one medication. */
export async function listPrices(db: Db, owner: User, medicationName?: string): Promise<(Price & { name: string })[]> {
    const rows = await db
        .select({ price, name: medication.name })
        .from(price)
        .innerJoin(medication, eq(medication.id, price.medicationId))
        .where(eq(medication.userId, owner.id))
        .orderBy(asc(medication.name), asc(price.date), asc(price.id));
    return rows
        .filter((row) => medicationName === undefined || row.name === medicationName)
        .map((row) => ({ ...row.price, name: row.name }));
}
