import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { calendarFeed, passkey, type CalendarFeed, type Db, type Passkey, type Tx } from '@med/db';

export async function listFeeds(db: Db): Promise<{ feed: CalendarFeed; passkey: Passkey }[]> {
    return db
        .select({ feed: calendarFeed, passkey })
        .from(calendarFeed)
        .innerJoin(passkey, eq(passkey.id, calendarFeed.passkeyId))
        .orderBy(desc(calendarFeed.createdAt));
}

/** A revoked feed URL answers 404 from then on. */
export async function revokeFeed(tx: Tx, id: number): Promise<CalendarFeed> {
    const [feed] = await tx
        .select()
        .from(calendarFeed)
        .where(and(eq(calendarFeed.id, id), isNull(calendarFeed.revokedAt)));
    if (!feed) throw new Error(`No unrevoked calendar feed #${id}`);
    await tx.update(calendarFeed).set({ revokedAt: sql`CURRENT_TIMESTAMP` }).where(eq(calendarFeed.id, id));
    return feed;
}
