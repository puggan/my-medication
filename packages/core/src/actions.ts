import { eq } from 'drizzle-orm';
import { medication, stockCount, transfer, type Medication, type Tx, type User } from '@med/db';
import { loadPlanInput } from './load.ts';
import { stockAt } from './plan.ts';
import { toDecimal, type Hundredths } from './tablets.ts';

/** Writes shared by the CLI and the web; each takes an open transaction. */

/** Refill organizers from the cupboard: tablets per organizer id. */
export async function recordRefill(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { amounts: Map<number, Hundredths>; date: string },
): Promise<void> {
    const rows = [...values.amounts].filter(([, tablets]) => tablets > 0);
    if (rows.length === 0) throw new Error(`Nothing to refill for ${med.name}`);
    await tx.insert(transfer).values(
        rows.map(([organizerId, tablets]) => ({
            medicationId: med.id,
            kind: 'refill' as const,
            organizerId,
            tablets: toDecimal(tablets),
            date: values.date,
            createdBy: owner.id,
        })),
    );
}

/** Packages picked up at the pharmacy, of the size this brand comes in. */
export async function recordPickup(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { packages: number; packageSize: number; price?: string; date: string; note?: string },
): Promise<void> {
    if (!Number.isInteger(values.packages) || values.packages < 1) throw new Error('Pick up at least one package');
    if (!Number.isInteger(values.packageSize) || values.packageSize < 1) throw new Error('A package holds at least one tablet');
    await tx.insert(transfer).values({
        medicationId: med.id,
        kind: 'pickup',
        tablets: toDecimal(values.packages * values.packageSize * 100),
        packages: values.packages,
        packageSize: values.packageSize,
        price: values.price,
        date: values.date,
        note: values.note,
        createdBy: owner.id,
    });
}

/**
 * A prescription adding tablets to tier 3, usable until expiresOn. A packageSize different from
 * the medication's becomes its new default.
 */
export async function recordRenew(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { tablets: Hundredths; date: string; expiresOn: string; packageSize?: number; note?: string },
): Promise<void> {
    if (values.tablets <= 0) throw new Error('A prescription needs at least one tablet');
    if (values.expiresOn < values.date) throw new Error(`The prescription expires ${values.expiresOn}, before ${values.date}`);
    await tx.insert(transfer).values({
        medicationId: med.id,
        kind: 'renew',
        tablets: toDecimal(values.tablets),
        date: values.date,
        expiresOn: values.expiresOn,
        note: values.note,
        createdBy: owner.id,
    });
    if (values.packageSize !== undefined && values.packageSize !== med.packageSize) {
        if (!Number.isInteger(values.packageSize) || values.packageSize < 1) throw new Error('A package holds at least one tablet');
        await tx.update(medication).set({ packageSize: values.packageSize }).where(eq(medication.id, med.id));
    }
}

/**
 * Tablets leaving tier outside of the normal flow, to match a count; negative tablets were found.
 * Opening stock is recorded as a negative drop.
 */
export async function recordDrop(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { tier: 1 | 2 | 3; organizerId?: number; tablets: Hundredths; date: string; note?: string },
): Promise<void> {
    if (values.tablets === 0) throw new Error('A drop of 0 tablets changes nothing');
    if ((values.tier === 1) !== (values.organizerId !== undefined)) throw new Error('Only tier 1 drops name an organizer');
    await tx.insert(transfer).values({
        medicationId: med.id,
        kind: 'drop',
        tier: values.tier,
        organizerId: values.organizerId,
        tablets: toDecimal(values.tablets),
        date: values.date,
        note: values.note,
        createdBy: owner.id,
    });
}

export interface CountResult {
    calculated: Hundredths;
    /** Calculated minus counted: positive when tablets are missing. */
    missing: Hundredths;
}

/** What one tier held at the end of date per the transfers, for comparing with a count. */
export async function calculatedStock(
    tx: Tx,
    owner: User,
    med: Medication,
    tier: 1 | 2 | 3,
    organizerId: number | undefined,
    date: string,
): Promise<Hundredths> {
    const input = await loadPlanInput(tx, owner, date);
    const planned = input.medications.find((m) => m.id === med.id)!;
    const stock = stockAt(input, planned, date);
    if (tier === 1) return stock.tier1.get(organizerId!) ?? 0;
    if (tier === 2) return stock.tier2;
    return stock.lots.filter((lot) => lot.expiresOn >= date).reduce((sum, lot) => sum + Math.max(0, lot.tablets), 0);
}

/**
 * Store what a tier actually held at the end of date, and how it compares with the calculation.
 * The count changes nothing by itself: a difference is settled with a drop, or by repairing the
 * transfer that was wrong.
 */
export async function recordCount(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { tier: 1 | 2 | 3; organizerId?: number; tablets: Hundredths; date: string },
): Promise<CountResult> {
    if ((values.tier === 1) !== (values.organizerId !== undefined)) throw new Error('Only tier 1 counts name an organizer');
    if (values.tablets < 0) throw new Error('A count is never negative');
    const calculated = await calculatedStock(tx, owner, med, values.tier, values.organizerId, values.date);
    await tx.insert(stockCount).values({
        medicationId: med.id,
        tier: values.tier,
        organizerId: values.organizerId,
        countedOn: values.date,
        tablets: toDecimal(values.tablets),
        createdBy: owner.id,
    });
    return { calculated, missing: calculated - values.tablets };
}
