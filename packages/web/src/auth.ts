import { createHmac, randomInt } from 'node:crypto';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { passkey, user, type Db, type Passkey, type User } from '@med/db';
import { origin, rpID, secure, sessionSecret } from './config.ts';

const SESSION_COOKIE = 'med_session';
const CHALLENGE_COOKIE = 'med_challenge';
const SESSION_SECONDS = 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;
/** Pending passkeys older than this are removed when a new one registers. */
const PENDING_DAYS = 7;
/** Most pending passkeys waiting at once, so the table can't be flooded. */
const MAX_PENDING = 10;
/** Pairing code characters, without look-alikes like 0/O and 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type Login =
    | { state: 'anonymous' }
    | { state: 'pending'; passkey: Passkey }
    | { state: 'approved'; passkey: Passkey; user: User };

interface Challenge {
    kind: 'register' | 'login';
    challenge: string;
    username: string;
    expires: number;
}

export class AuthError extends Error {}

export function normalizeUsername(value: unknown): string {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[a-z0-9._-]{1,64}$/.test(name)) throw new AuthError('Enter a username of letters, digits, . _ or -');
    return name;
}

const cookieOptions = (maxAge: number) =>
    ({ httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge }) as const;

async function setJsonCookie(c: Context, name: string, value: object, maxAge: number): Promise<void> {
    await setSignedCookie(c, name, JSON.stringify(value), sessionSecret, cookieOptions(maxAge));
}

async function getJsonCookie<T extends { expires: number }>(c: Context, name: string): Promise<T | undefined> {
    const raw = await getSignedCookie(c, sessionSecret, name);
    if (!raw) return undefined;
    try {
        const value = JSON.parse(raw) as T;
        return value.expires > Date.now() ? value : undefined;
    } catch {
        return undefined;
    }
}

/** The passkey behind the session cookie, if it is still valid and not revoked. */
export async function currentLogin(db: Db, c: Context): Promise<Login> {
    const session = await getJsonCookie<{ passkeyId: number; expires: number }>(c, SESSION_COOKIE);
    if (!session) return { state: 'anonymous' };
    const [row] = await db
        .select({ passkey, user })
        .from(passkey)
        .leftJoin(user, eq(user.id, passkey.userId))
        .where(and(eq(passkey.id, session.passkeyId), isNull(passkey.revokedAt)));
    if (!row) return { state: 'anonymous' };
    if (row.passkey.approvedAt !== null && row.user) return { state: 'approved', passkey: row.passkey, user: row.user };
    return { state: 'pending', passkey: row.passkey };
}

export function logout(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure });
}

/** Passkeys a username may log in with: approved for that user, or pending under that name. */
async function passkeysFor(db: Db, username: string): Promise<Passkey[]> {
    const rows = await db
        .select({ passkey })
        .from(passkey)
        .leftJoin(user, eq(user.id, passkey.userId))
        .where(
            and(
                isNull(passkey.revokedAt),
                or(
                    and(isNotNull(passkey.approvedAt), eq(user.name, username)),
                    and(isNull(passkey.approvedAt), eq(passkey.requestedName, username)),
                ),
            ),
        );
    return rows.map((row) => row.passkey);
}

const toBase64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const credentialRef = (key: Passkey) => ({ id: toBase64url(key.credentialId), transports: key.transports ?? undefined });

/** The same WebAuthn user handle for a name every time, so a device keeps one passkey per name. */
function userHandle(username: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(createHmac('sha256', sessionSecret).update(`user:${username}`).digest().subarray(0, 16));
}

export async function registrationOptions(db: Db, c: Context, username: string) {
    const options = await generateRegistrationOptions({
        rpName: 'Medication stock',
        rpID,
        userName: username,
        userDisplayName: username,
        userID: userHandle(username),
        attestationType: 'none',
        excludeCredentials: (await passkeysFor(db, username)).map(credentialRef),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await setJsonCookie(
        c,
        CHALLENGE_COOKIE,
        { kind: 'register', challenge: options.challenge, username, expires: Date.now() + CHALLENGE_SECONDS * 1000 },
        CHALLENGE_SECONDS,
    );
    return options;
}

/** Login options for the name's passkeys, or undefined when it has none and must register. */
export async function loginOptions(db: Db, c: Context, username: string) {
    const keys = await passkeysFor(db, username);
    if (keys.length === 0) return undefined;
    const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: keys.map(credentialRef),
        userVerification: 'preferred',
    });
    await setJsonCookie(
        c,
        CHALLENGE_COOKIE,
        { kind: 'login', challenge: options.challenge, username, expires: Date.now() + CHALLENGE_SECONDS * 1000 },
        CHALLENGE_SECONDS,
    );
    return options;
}

async function takeChallenge(c: Context, kind: Challenge['kind']): Promise<Challenge> {
    const challenge = await getJsonCookie<Challenge>(c, CHALLENGE_COOKIE);
    deleteCookie(c, CHALLENGE_COOKIE, { path: '/', secure });
    if (!challenge || challenge.kind !== kind) throw new AuthError('The passkey request expired, try again');
    return challenge;
}

async function startSession(c: Context, passkeyId: number): Promise<void> {
    await setJsonCookie(c, SESSION_COOKIE, { passkeyId, expires: Date.now() + SESSION_SECONDS * 1000 }, SESSION_SECONDS);
}

function pairingCode(): string {
    return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

/** A short description of the device from its User-Agent, to tell passkeys apart in the CLI. */
function deviceLabel(userAgent: string | undefined): string {
    const ua = userAgent ?? '';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : 'unknown browser';
    return `${browser} on ${os}`;
}

export async function verifyRegistration(db: Db, c: Context, response: RegistrationResponseJSON): Promise<Passkey> {
    const challenge = await takeChallenge(c, 'register');
    const { verified, registrationInfo } = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
    }).catch((error: Error) => {
        throw new AuthError(`The passkey could not be verified: ${error.message}`);
    });
    if (!verified) throw new AuthError('The passkey could not be verified');

    await db
        .delete(passkey)
        .where(and(isNull(passkey.approvedAt), lt(passkey.createdAt, sql`NOW() - INTERVAL ${PENDING_DAYS} DAY`)));
    const [{ pending }] = (await db
        .select({ pending: sql<number>`COUNT(*)` })
        .from(passkey)
        .where(and(isNull(passkey.approvedAt), isNull(passkey.revokedAt)))) as [{ pending: number }];
    if (Number(pending) >= MAX_PENDING) throw new AuthError('Too many devices are waiting for approval already');

    const { credential } = registrationInfo;
    const [{ id }] = (await db
        .insert(passkey)
        .values({
            requestedName: challenge.username,
            credentialId: Buffer.from(credential.id, 'base64url'),
            publicKey: Buffer.from(credential.publicKey),
            signCount: credential.counter,
            transports: credential.transports ?? null,
            label: deviceLabel(c.req.header('user-agent')),
            pairingCode: pairingCode(),
        })
        .$returningId()) as [{ id: number }];
    await startSession(c, id);
    const [created] = await db.select().from(passkey).where(eq(passkey.id, id));
    return created!;
}

export async function verifyLogin(db: Db, c: Context, response: AuthenticationResponseJSON): Promise<void> {
    const challenge = await takeChallenge(c, 'login');
    const key = (await passkeysFor(db, challenge.username)).find((k) => toBase64url(k.credentialId) === response.id);
    if (!key) throw new AuthError('This passkey is not registered for that username');
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
            id: toBase64url(key.credentialId),
            publicKey: new Uint8Array(key.publicKey),
            counter: key.signCount,
            transports: key.transports ?? undefined,
        },
        requireUserVerification: false,
    }).catch((error: Error) => {
        throw new AuthError(`The passkey could not be verified: ${error.message}`);
    });
    if (!verified) throw new AuthError('The passkey could not be verified');
    await db
        .update(passkey)
        .set({ signCount: authenticationInfo.newCounter, lastUsedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(passkey.id, key.id));
    await startSession(c, key.id);
}
