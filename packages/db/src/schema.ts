import { sql } from 'drizzle-orm';
import {
    char,
    check,
    customType,
    date,
    datetime,
    decimal,
    foreignKey,
    index,
    int,
    json,
    mysqlEnum,
    mysqlTable,
    smallint,
    tinyint,
    uniqueIndex,
    varchar,
} from 'drizzle-orm/mysql-core';

/** Tablet count; two decimals so half and quarter tablets fit. */
const tablets = () => decimal({ precision: 8, scale: 2, mode: 'string' });
const money = () => decimal({ precision: 10, scale: 2, mode: 'string' });
const day = () => date({ mode: 'string' });
const timestamp = () => datetime({ mode: 'string' });
/** Raw bytes; drizzle's own varbinary decodes them as a UTF-8 string, which breaks binary keys. */
const bytes = customType<{ data: Buffer; driverData: Buffer; config: { length: number } }>({
    dataType: (config) => `varbinary(${config!.length})`,
    fromDriver: (value) => Buffer.from(value),
});
const createdAt = () => timestamp().notNull().default(sql`CURRENT_TIMESTAMP`);

/**
 * Tiers stock moves through: 3 is what the pharmacy still holds on the prescription, 2 the
 * cupboard at home, 1 the pill organizers that drain by the dose every day. Tier 1 is kept per
 * organizer, all of them filled from the same tier 2 stock.
 */
export const tiers = [1, 2, 3] as const;
export type Tier = (typeof tiers)[number];

/** Person whose medications are tracked, and who logs in on the web. Organizers are refilled on refillWeekday (0 = Sunday). */
export const user = mysqlTable('user', {
    id: int({ unsigned: true }).autoincrement().primaryKey(),
    name: varchar({ length: 64 }).notNull().unique('user_name'),
    refillWeekday: tinyint({ unsigned: true }).notNull().default(0),
    /** How long before a refill a short cupboard is warned about (Sunday refill, Wednesday warning). */
    pickupWarningDays: tinyint({ unsigned: true }).notNull().default(4),
    /** How long renewing a prescription can take, from contacting the doctor until pickup. */
    renewalLeadDays: tinyint({ unsigned: true }).notNull().default(30),
    createdAt: createdAt(),
}, () => [check('user_refill_weekday', sql`refill_weekday BETWEEN 0 AND 6`)]);

/**
 * Set of pill organizers for one time of day, e.g. two weekly morning containers. It holds
 * containers × containerDays and is refilled once a container is empty, back up to full.
 */
export const organizer = mysqlTable(
    'organizer',
    {
        id: int({ unsigned: true }).autoincrement().primaryKey(),
        userId: int({ unsigned: true }).notNull(),
        name: varchar({ length: 32 }).notNull(),
        containers: tinyint({ unsigned: true }).notNull().default(1),
        containerDays: tinyint({ unsigned: true }).notNull().default(7),
        createdAt: createdAt(),
    },
    (t) => [
        uniqueIndex('organizer_user_name').on(t.userId, t.name),
        foreignKey({ name: 'organizer_user', columns: [t.userId], foreignColumns: [user.id] }),
        check('organizer_size', sql`containers > 0 AND container_days > 0`),
    ],
);

/**
 * packageSize and packagePrice are the usual package; actual pickups record what they got and paid.
 * The yearly cost is calculated from the dose, never stored.
 */
export const medication = mysqlTable(
    'medication',
    {
        id: int({ unsigned: true }).autoincrement().primaryKey(),
        userId: int({ unsigned: true }).notNull(),
        name: varchar({ length: 128 }).notNull(),
        packageSize: smallint({ unsigned: true }).notNull(),
        packagePrice: money(),
        createdAt: createdAt(),
    },
    (t) => [
        uniqueIndex('medication_user_name').on(t.userId, t.name),
        foreignKey({ name: 'medication_user', columns: [t.userId], foreignColumns: [user.id] }),
        check('medication_package_size', sql`package_size > 0`),
    ],
);

/**
 * Daily dose put in one organizer, from startDate until the next row for the same organizer;
 * 0 ends it there. A medication taken morning and evening has rows for both organizers.
 */
export const dose = mysqlTable(
    'dose',
    {
        id: int({ unsigned: true }).autoincrement().primaryKey(),
        medicationId: int({ unsigned: true }).notNull(),
        organizerId: int({ unsigned: true }).notNull(),
        startDate: day().notNull(),
        perDay: tablets().notNull(),
        createdAt: createdAt(),
    },
    (t) => [
        uniqueIndex('dose_medication_organizer_start').on(t.medicationId, t.organizerId, t.startDate),
        foreignKey({ name: 'dose_medication', columns: [t.medicationId], foreignColumns: [medication.id] }),
        foreignKey({ name: 'dose_organizer', columns: [t.organizerId], foreignColumns: [organizer.id] }),
        check('dose_per_day', sql`per_day >= 0`),
    ],
);

/**
 * Confirmed movement of tablets, dated at the end of the day it happened:
 * - renew: a new prescription adds to tier 3, usable until expiresOn
 * - pickup: tier 3 to 2, packages of packageSize as bought (brands differ), taken from the
 *   prescription that expires first
 * - refill: tier 2 to 1, into organizerId
 * - drop: tablets leave tier (lost, broken, expired) to match a count; negative when found.
 *   A tier 1 drop names the organizer.
 * The daily drain of tier 1 is calculated from dose, never stored.
 */
export const transferKinds = ['renew', 'pickup', 'refill', 'drop'] as const;
export type TransferKind = (typeof transferKinds)[number];

export const transfer = mysqlTable(
    'transfer',
    {
        id: int({ unsigned: true }).autoincrement().primaryKey(),
        medicationId: int({ unsigned: true }).notNull(),
        kind: mysqlEnum(transferKinds).notNull(),
        date: day().notNull(),
        tablets: tablets().notNull(),
        /** Only for drop: the tier the tablets left. */
        tier: tinyint({ unsigned: true }),
        /** The organizer of a refill, or of a tier 1 drop. */
        organizerId: int({ unsigned: true }),
        packages: smallint({ unsigned: true }),
        packageSize: smallint({ unsigned: true }),
        /** Total paid for a pickup. */
        price: money(),
        /** Only for renew: the last day the prescription can be picked up. */
        expiresOn: day(),
        note: varchar({ length: 255 }),
        createdBy: int({ unsigned: true }).notNull(),
        createdAt: createdAt(),
        updatedAt: timestamp(),
    },
    (t) => [
        index('transfer_medication_date').on(t.medicationId, t.date),
        foreignKey({ name: 'transfer_medication', columns: [t.medicationId], foreignColumns: [medication.id] }),
        foreignKey({ name: 'transfer_organizer', columns: [t.organizerId], foreignColumns: [organizer.id] }),
        foreignKey({ name: 'transfer_created_by', columns: [t.createdBy], foreignColumns: [user.id] }),
        check('transfer_drop_tier', sql`(kind = 'drop') = (tier IS NOT NULL) AND (tier IS NULL OR tier BETWEEN 1 AND 3)`),
        check('transfer_tablets', sql`kind = 'drop' OR tablets > 0`),
        check('transfer_organizer_tier', sql`(organizer_id IS NOT NULL) = (kind = 'refill' OR tier = 1)`),
        check('transfer_expires', sql`(kind = 'renew') = (expires_on IS NOT NULL)`),
        check('transfer_price', sql`price IS NULL OR kind = 'pickup'`),
        check('transfer_packages', sql`(packages IS NULL) = (package_size IS NULL) AND (packages IS NULL OR kind = 'pickup')`),
    ],
);

/**
 * What a tier actually held at the end of countedOn. Counts don't change the calculated stock:
 * a difference is settled with a drop, or by repairing the transfer that was wrong.
 */
export const stockCount = mysqlTable(
    'stock_count',
    {
        id: int({ unsigned: true }).autoincrement().primaryKey(),
        medicationId: int({ unsigned: true }).notNull(),
        tier: tinyint({ unsigned: true }).notNull(),
        /** Set exactly for tier 1 counts. */
        organizerId: int({ unsigned: true }),
        countedOn: day().notNull(),
        tablets: tablets().notNull(),
        createdBy: int({ unsigned: true }).notNull(),
        createdAt: createdAt(),
    },
    (t) => [
        index('stock_count_medication_date').on(t.medicationId, t.countedOn),
        foreignKey({ name: 'stock_count_medication', columns: [t.medicationId], foreignColumns: [medication.id] }),
        foreignKey({ name: 'stock_count_organizer', columns: [t.organizerId], foreignColumns: [organizer.id] }),
        foreignKey({ name: 'stock_count_created_by', columns: [t.createdBy], foreignColumns: [user.id] }),
        check('stock_count_tier', sql`tier BETWEEN 1 AND 3 AND (tier = 1) = (organizer_id IS NOT NULL)`),
        check('stock_count_tablets', sql`tablets >= 0`),
    ],
);

/**
 * WebAuthn credential registered from the web for requestedName. It starts out pending, shown with
 * pairingCode, and only the CLI can connect it to a user and approve it. A pending key can log in,
 * but only to be told it waits for approval; revoked keys can't log in at all.
 */
export const passkey = mysqlTable(
    'passkey',
    {
        id: int({ unsigned: true }).autoincrement().primaryKey(),
        userId: int({ unsigned: true }),
        requestedName: varchar({ length: 64 }).notNull(),
        credentialId: bytes({ length: 1023 }).notNull(),
        publicKey: bytes({ length: 1023 }).notNull(),
        signCount: int({ unsigned: true }).notNull().default(0),
        transports: json().$type<string[]>(),
        label: varchar({ length: 255 }).notNull(),
        pairingCode: char({ length: 6 }).notNull(),
        createdAt: createdAt(),
        approvedAt: timestamp(),
        revokedAt: timestamp(),
        lastUsedAt: timestamp(),
    },
    (t) => [
        uniqueIndex('passkey_credential').on(t.credentialId),
        index('passkey_pairing_code').on(t.pairingCode),
        index('passkey_requested_name').on(t.requestedName),
        foreignKey({ name: 'passkey_user', columns: [t.userId], foreignColumns: [user.id] }),
        check('passkey_approved_user', sql`approved_at IS NULL OR user_id IS NOT NULL`),
    ],
);

export type User = typeof user.$inferSelect;
export type Organizer = typeof organizer.$inferSelect;
export type Medication = typeof medication.$inferSelect;
export type Dose = typeof dose.$inferSelect;
export type Transfer = typeof transfer.$inferSelect;
export type StockCount = typeof stockCount.$inferSelect;
export type Passkey = typeof passkey.$inferSelect;
