import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { dose, medication, organizer, transfer, user, type Db, type Medication, type Organizer, type Tx, type User } from '@med/db';

/** The named user, or the only one when no name is given. */
export async function findUser(db: Db | Tx, name: string | undefined): Promise<User> {
    const users = await db.select().from(user).where(name === undefined ? undefined : eq(user.name, name));
    if (users.length === 1) return users[0]!;
    if (name !== undefined) throw new Error(`No user named "${name}"`);
    throw new Error(`${users.length} users exist, choose one with --user`);
}

/** The named organizer, or the only one when no name is given. */
export async function findOrganizer(db: Db | Tx, owner: User, name: string | undefined): Promise<Organizer> {
    const organizers = await db
        .select()
        .from(organizer)
        .where(and(eq(organizer.userId, owner.id), name === undefined ? undefined : eq(organizer.name, name)));
    if (organizers.length === 1) return organizers[0]!;
    if (name !== undefined) throw new Error(`${owner.name} has no organizer named "${name}"`);
    throw new Error(`${owner.name} has ${organizers.length} organizers, choose one with --organizer`);
}

export async function listOrganizers(db: Db, owner: User): Promise<Organizer[]> {
    return db.select().from(organizer).where(eq(organizer.userId, owner.id)).orderBy(asc(organizer.id));
}

export async function addOrganizer(
    tx: Tx,
    owner: User,
    values: { name: string; containers: number; containerDays: number },
): Promise<void> {
    const [existing] = await tx
        .select({ id: organizer.id })
        .from(organizer)
        .where(and(eq(organizer.userId, owner.id), eq(organizer.name, values.name)));
    if (existing) throw new Error(`${owner.name} already has an organizer named "${values.name}"`);
    await tx.insert(organizer).values({ userId: owner.id, ...values });
}

export async function findMedication(db: Db | Tx, owner: User, name: string): Promise<Medication> {
    const [found] = await db
        .select()
        .from(medication)
        .where(and(eq(medication.userId, owner.id), eq(medication.name, name)));
    if (!found) throw new Error(`${owner.name} has no medication named "${name}"`);
    return found;
}

export async function addMedication(
    tx: Tx,
    owner: User,
    values: { name: string; organizer: Organizer; perDay: string; packageSize: number; packagePrice?: string; from: string },
): Promise<Medication> {
    const [existing] = await tx
        .select({ id: medication.id })
        .from(medication)
        .where(and(eq(medication.userId, owner.id), eq(medication.name, values.name)));
    if (existing) throw new Error(`${owner.name} already has a medication named "${values.name}"`);

    const [{ id }] = await tx.insert(medication).values({
        userId: owner.id,
        name: values.name,
        packageSize: values.packageSize,
        packagePrice: values.packagePrice,
    }).$returningId() as [{ id: number }];
    await tx
        .insert(dose)
        .values({ medicationId: id, organizerId: values.organizer.id, startDate: values.from, perDay: values.perDay });
    return findMedication(tx, owner, values.name);
}

/** Set the dose in one organizer from a date on; a row already starting that day is replaced. */
export async function setDose(tx: Tx, med: Medication, box: Organizer, perDay: string, from: string): Promise<void> {
    await tx
        .insert(dose)
        .values({ medicationId: med.id, organizerId: box.id, startDate: from, perDay })
        .onDuplicateKeyUpdate({ set: { perDay } });
}

/** The dose in effect on date per organizer id; organizers without a dose yet are left out. */
export async function dosesOn(db: Db | Tx, med: Medication, date: string): Promise<Map<number, string>> {
    const rows = await db
        .select({ organizerId: dose.organizerId, perDay: dose.perDay })
        .from(dose)
        .where(and(eq(dose.medicationId, med.id), lte(dose.startDate, date)))
        .orderBy(desc(dose.startDate));
    const doses = new Map<number, string>();
    for (const row of rows) if (!doses.has(row.organizerId)) doses.set(row.organizerId, row.perDay);
    return doses;
}

export async function listMedications(db: Db, owner: User, date: string) {
    const meds = await db.select().from(medication).where(eq(medication.userId, owner.id)).orderBy(asc(medication.name));
    return Promise.all(meds.map(async (med) => ({ med, doses: await dosesOn(db, med, date) })));
}

/**
 * Tablets leaving tier outside of the normal flow, to match a count; negative tablets were found.
 * Opening stock is recorded as a negative drop.
 */
export async function addDrop(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { tier: 1 | 2 | 3; organizer?: Organizer; tablets: string; date: string; note?: string },
): Promise<void> {
    if (Number(values.tablets) === 0) throw new Error('A drop of 0 tablets changes nothing');
    if ((values.tier === 1) !== (values.organizer !== undefined)) throw new Error('Only tier 1 drops name an organizer');
    await tx.insert(transfer).values({
        medicationId: med.id,
        kind: 'drop',
        tier: values.tier,
        organizerId: values.organizer?.id,
        tablets: values.tablets,
        date: values.date,
        note: values.note,
        createdBy: owner.id,
    });
}

/** A prescription adding tablets to tier 3, usable until expiresOn. */
export async function addRenew(
    tx: Tx,
    owner: User,
    med: Medication,
    values: { tablets: string; date: string; expiresOn: string; note?: string },
): Promise<void> {
    if (Number(values.tablets) === 0) throw new Error('A prescription of 0 tablets changes nothing');
    if (values.expiresOn < values.date) throw new Error(`The prescription expires ${values.expiresOn}, before ${values.date}`);
    await tx.insert(transfer).values({
        medicationId: med.id,
        kind: 'renew',
        tablets: values.tablets,
        date: values.date,
        expiresOn: values.expiresOn,
        note: values.note,
        createdBy: owner.id,
    });
}
