import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
    calculatedStock,
    loadPlanInput,
    plan,
    recordCount,
    recordDrop,
    recordPickup,
    recordRefill,
    recordRenew,
    today,
} from '@med/core';
import { medication, organizer, type Db, type Tx, type User } from '@med/db';
import {
    AuthError,
    currentLogin,
    loginOptions,
    logout,
    normalizeUsername,
    registrationOptions,
    verifyLogin,
    verifyRegistration,
} from './auth.ts';
import { createFeed } from './calendar.ts';
import { overview } from './overview.ts';

/** A request the user can fix; answered with 400 and the message. */
class InputError extends Error {}

function positiveInt(name: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new InputError(`${name} must be a whole number above 0`);
    return value;
}

/** Tablets as a number with at most two decimals, converted to hundredths. */
function tabletCount(name: string, value: unknown, { allowZero = false } = {}): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
        throw new InputError(`${name} must be a number of tablets`);
    }
    const hundredths = Math.round(value * 100);
    if (Math.abs(hundredths - value * 100) > 1e-6) throw new InputError(`${name} can have at most two decimals`);
    return hundredths;
}

function dateString(name: string, value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new InputError(`${name} must be a date`);
    }
    return value;
}

async function ownMedication(db: Db | Tx, owner: User, id: unknown) {
    const [med] = await db
        .select()
        .from(medication)
        .where(and(eq(medication.id, positiveInt('medicationId', id)), eq(medication.userId, owner.id)));
    if (!med) throw new InputError('No such medication');
    return med;
}

async function ownOrganizer(db: Db | Tx, owner: User, id: unknown) {
    const [box] = await db
        .select()
        .from(organizer)
        .where(and(eq(organizer.id, positiveInt('organizerId', id)), eq(organizer.userId, owner.id)));
    if (!box) throw new InputError('No such organizer');
    return box;
}

async function body(c: Context): Promise<Record<string, unknown>> {
    const value: unknown = await c.req.json().catch(() => undefined);
    if (typeof value !== 'object' || value === null) throw new InputError('Expected a JSON object');
    return value as Record<string, unknown>;
}

export function api(db: Db) {
    const app = new Hono<{ Variables: { user: User; passkeyId: number } }>();

    app.onError((error, c) => {
        if (error instanceof InputError || error instanceof AuthError) return c.json({ error: error.message }, 400);
        console.error(error);
        return c.json({ error: 'Something went wrong on the server' }, 500);
    });

    app.get('/me', async (c) => {
        const login = await currentLogin(db, c);
        if (login.state === 'anonymous') return c.json({ state: 'anonymous' });
        if (login.state === 'pending') {
            return c.json({ state: 'pending', username: login.passkey.requestedName, pairingCode: login.passkey.pairingCode });
        }
        return c.json({ state: 'approved', username: login.user.name });
    });

    app.post('/login/options', async (c) => {
        const username = normalizeUsername((await body(c)).username);
        const options = await loginOptions(db, c, username);
        return options ? c.json({ mode: 'login', options }) : c.json({ mode: 'register', options: await registrationOptions(db, c, username) });
    });

    app.post('/register/options', async (c) => {
        const username = normalizeUsername((await body(c)).username);
        return c.json({ mode: 'register', options: await registrationOptions(db, c, username) });
    });

    app.post('/register/verify', async (c) => {
        await verifyRegistration(db, c, (await body(c)) as never);
        return c.json({ ok: true });
    });

    app.post('/login/verify', async (c) => {
        await verifyLogin(db, c, (await body(c)) as never);
        return c.json({ ok: true });
    });

    app.post('/logout', (c) => {
        logout(c);
        return c.json({ ok: true });
    });

    // Everything below needs an approved passkey
    app.use('*', async (c, next) => {
        const login = await currentLogin(db, c);
        if (login.state !== 'approved') return c.json({ error: 'Not logged in' }, 401);
        c.set('user', login.user);
        c.set('passkeyId', login.passkey.id);
        await next();
    });

    app.get('/overview', async (c) => {
        const owner = c.get('user');
        return c.json(overview(await loadPlanInput(db, owner), owner.name));
    });

    /** A new calendar feed URL, shown this once. */
    app.post('/feeds', async (c) => {
        const input = await body(c);
        const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : 'Calendar';
        if (name.length > 64) throw new InputError('A feed name is at most 64 characters');
        return c.json({ url: await createFeed(db, c.get('passkeyId'), name) });
    });

    app.post('/refill', async (c) => {
        const owner = c.get('user');
        const input = await body(c);
        const date = today();
        const count = await db.transaction(async (tx) => {
            const box = await ownOrganizer(tx, owner, input.organizerId);
            const due = plan(await loadPlanInput(tx, owner, date)).events.filter(
                (event) => event.action === 'refill' && event.actionDate <= date && event.refill!.has(box.id),
            );
            if (due.length === 0) throw new InputError(`No refill of ${box.name} is due today`);
            for (const event of due) {
                const med = await ownMedication(tx, owner, event.medicationId);
                await recordRefill(tx, owner, med, { amounts: new Map([[box.id, event.refill!.get(box.id)!]]), date });
            }
            return due.length;
        });
        return c.json({ ok: true, medications: count });
    });

    app.post('/pickup', async (c) => {
        const owner = c.get('user');
        const input = await body(c);
        await db.transaction(async (tx) => {
            const med = await ownMedication(tx, owner, input.medicationId);
            await recordPickup(tx, owner, med, {
                packages: positiveInt('packages', input.packages),
                packageSize: positiveInt('packageSize', input.packageSize),
                date: today(),
            });
        });
        return c.json({ ok: true });
    });

    app.post('/renew', async (c) => {
        const owner = c.get('user');
        const input = await body(c);
        await db.transaction(async (tx) => {
            const med = await ownMedication(tx, owner, input.medicationId);
            await recordRenew(tx, owner, med, {
                tablets: tabletCount('tablets', input.tablets),
                packageSize: positiveInt('packageSize', input.packageSize),
                expiresOn: dateString('expiresOn', input.expiresOn),
                date: today(),
            });
        });
        return c.json({ ok: true });
    });

    /** With preview only the calculated stock is returned; otherwise the count is saved. */
    app.post('/count', async (c) => {
        const owner = c.get('user');
        const input = await body(c);
        const tier = input.tier;
        if (tier !== 1 && tier !== 2 && tier !== 3) throw new InputError('tier must be 1, 2 or 3');
        const date = today();
        const result = await db.transaction(async (tx) => {
            const med = await ownMedication(tx, owner, input.medicationId);
            const organizerId = tier === 1 ? (await ownOrganizer(tx, owner, input.organizerId)).id : undefined;
            if (input.preview === true) {
                const calculated = await calculatedStock(tx, owner, med, tier, organizerId, date);
                return { calculated: calculated / 100 };
            }
            const counted = tabletCount('tablets', input.tablets, { allowZero: true });
            const { calculated, missing } = await recordCount(tx, owner, med, { tier, organizerId, tablets: counted, date });
            if (input.drop === true && missing !== 0) {
                await recordDrop(tx, owner, med, { tier, organizerId, tablets: missing, date, note: 'Settles a count' });
            }
            return { calculated: calculated / 100, missing: missing / 100, dropped: input.drop === true && missing !== 0 };
        });
        return c.json({ ok: true, ...result });
    });

    return app;
}
