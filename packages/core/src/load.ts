import { asc, eq, inArray } from 'drizzle-orm';
import { dose, medication, organizer, transfer, type Db, type Tx, type User } from '@med/db';
import { today as swedishToday } from './dates.ts';
import { plan, type Plan, type PlanInput } from './plan.ts';
import { fromDecimal } from './tablets.ts';

/** Everything the calculation needs for one user's medications. */
export async function loadPlanInput(db: Db | Tx, owner: User, today = swedishToday()): Promise<PlanInput> {
    const organizers = await db.select().from(organizer).where(eq(organizer.userId, owner.id)).orderBy(asc(organizer.id));
    const meds = await db.select().from(medication).where(eq(medication.userId, owner.id)).orderBy(asc(medication.name));
    const ids = meds.map((med) => med.id);
    const doses = ids.length === 0 ? [] : await db.select().from(dose).where(inArray(dose.medicationId, ids));
    const transfers = ids.length === 0 ? [] : await db.select().from(transfer).where(inArray(transfer.medicationId, ids));
    return {
        today,
        refillWeekday: owner.refillWeekday,
        pickupWarningDays: owner.pickupWarningDays,
        renewalLeadDays: owner.renewalLeadDays,
        organizers: organizers.map(({ id, name, containers, containerDays }) => ({ id, name, containers, containerDays })),
        medications: meds.map((med) => ({
            id: med.id,
            name: med.name,
            packageSize: med.packageSize,
            doses: doses
                .filter((d) => d.medicationId === med.id)
                .map((d) => ({ organizerId: d.organizerId, startDate: d.startDate, perDay: fromDecimal(d.perDay) })),
            transfers: transfers
                .filter((t) => t.medicationId === med.id)
                .map((t) => ({
                    id: t.id,
                    kind: t.kind,
                    date: t.date,
                    tablets: fromDecimal(t.tablets),
                    tier: t.tier,
                    organizerId: t.organizerId,
                    expiresOn: t.expiresOn,
                    countsInStock: t.countsInStock,
                })),
        })),
    };
}

export async function loadPlan(db: Db | Tx, owner: User, today?: string): Promise<Plan> {
    return plan(await loadPlanInput(db, owner, today));
}
