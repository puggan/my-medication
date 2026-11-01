import type { Db, Tx } from '@med/db';

/** Thrown inside the transaction to roll back a dry run after all checks have passed. */
class DryRun extends Error {}

/** Run work in one transaction; with dryRun everything is checked and counted, then rolled back. */
export async function inTransaction<T>(db: Db, dryRun: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
    let result: T | undefined;
    try {
        await db.transaction(async (tx) => {
            result = await work(tx);
            if (dryRun) throw new DryRun();
        });
    } catch (error) {
        if (!(error instanceof DryRun)) throw error;
    }
    return result as T;
}
