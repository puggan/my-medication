import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { addDays, loadPlanInput } from '@med/core';
import { calendarFeed, passkey, user, type Db, type User } from '@med/db';
import { origin } from './config.ts';
import { overview } from './overview.ts';
import type { OverviewEvent } from './types.ts';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Create a feed for the logged-in passkey; the URL holds the only copy of the token. */
export async function createFeed(db: Db, passkeyId: number, name: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await db.insert(calendarFeed).values({ passkeyId, tokenHash: hashToken(token), name });
    return `${origin.replace(/^https?:/, 'webcal:')}/calendar/${token}.ics`;
}

/** The user behind a feed token, if neither the feed nor its passkey is revoked. */
export async function feedUser(db: Db, token: string): Promise<User | undefined> {
    const [row] = await db
        .select({ feedId: calendarFeed.id, user })
        .from(calendarFeed)
        .innerJoin(passkey, eq(passkey.id, calendarFeed.passkeyId))
        .innerJoin(user, eq(user.id, passkey.userId))
        .where(
            and(
                eq(calendarFeed.tokenHash, hashToken(token)),
                isNull(calendarFeed.revokedAt),
                isNull(passkey.revokedAt),
                isNotNull(passkey.approvedAt),
            ),
        );
    if (!row) return undefined;
    await db.update(calendarFeed).set({ lastFetchedAt: sql`CURRENT_TIMESTAMP` }).where(eq(calendarFeed.id, row.feedId));
    return row.user;
}

/** Text values escaped as RFC 5545 requires. */
function text(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string): string {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;
    const parts: string[] = [];
    let start = 0;
    while (start < bytes.length) {
        let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
        // Never split a UTF-8 character
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        parts.push(bytes.subarray(start, end).toString('utf8'));
        start = end;
    }
    return parts.join('\r\n ');
}

const icsDate = (date: string) => date.replace(/-/g, '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmt = (n: number) => String(Math.round(n * 100) / 100);

function describe(event: OverviewEvent): { summary: string; details: string[] } {
    switch (event.action) {
        case 'refill':
            return {
                summary: `Refill the ${event.organizerName} organizer`,
                details: event.items.map((item) => `${item.name}: ${fmt(item.tablets)}`),
            };
        case 'pickup':
            return {
                summary: `Pick up ${event.medicationName} (${plural(event.packages ?? 1, 'package')})`,
                details: event.needsRenewal ? ['From the new prescription, once the doctor has renewed it'] : [],
            };
        case 'pickup-before-expiry':
            return {
                summary: `Pick up ${event.medicationName} (${plural(event.packages ?? 1, 'package')}) before expiry`,
                details: [`The prescription expires ${event.expiresOn}`],
            };
        case 'contact-doctor':
            return {
                summary: `Contact the doctor about ${event.medicationName}`,
                details: [event.expiresOn ? `The prescription expired ${event.expiresOn}` : 'Nothing left to pick up on the prescription'],
            };
    }
}

/**
 * The event list as an iCalendar feed of all-day events. A late event moves to today so it stays in
 * sight. UIDs count occurrences per action and subject, so a recalculated date moves an event
 * instead of adding a new one.
 */
export async function feed(db: Db, owner: User): Promise<string> {
    const data = overview(await loadPlanInput(db, owner), owner.name);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const seen = new Map<string, number>();
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//med.sundragon.se//Medication stock//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Medication actions',
        'X-WR-TIMEZONE:Europe/Stockholm',
        'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        'X-PUBLISHED-TTL:PT1H',
    ];
    for (const event of data.events) {
        const subject = event.action === 'refill' ? `organizer-${event.organizerId}` : `medication-${event.medicationId}`;
        const key = `${event.action}-${subject}`;
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);

        const late = event.actionDate < data.today;
        const day = late ? data.today : event.actionDate;
        const { summary, details } = describe(event);
        const description = [...details, `Runs out ${event.runsOut} if nothing is done.`, `${origin}/`];
        lines.push(
            'BEGIN:VEVENT',
            `UID:${key}-${occurrence}@${new URL(origin).hostname}`,
            `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${icsDate(day)}`,
            `DTEND;VALUE=DATE:${icsDate(addDays(day, 1))}`,
            `SUMMARY:${text(late ? `Late since ${event.actionDate}: ${summary}` : summary)}`,
            `DESCRIPTION:${text(description.join('\n'))}`,
            `URL:${origin}/`,
            'TRANSP:TRANSPARENT',
            'END:VEVENT',
        );
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
}
