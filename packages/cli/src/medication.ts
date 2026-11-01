import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { dose, medication, organizer, user, type Db, type Medication, type Organizer, type Tx, type User } from '@med/db';

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

/** The named organizer, or when no name is given the only one med has a dose in. */
export async function findOrganizerFor(
    db: Db | Tx,
    owner: User,
    med: Medication,
    name: string | undefined,
): Promise<Organizer> {
    if (name !== undefined) return findOrganizer(db, owner, name);
    const used = await db
        .selectDistinct({ organizer })
        .from(dose)
        .innerJoin(organizer, eq(organizer.id, dose.organizerId))
        .where(eq(dose.medicationId, med.id));
    if (used.length === 1) return used[0]!.organizer;
    throw new Error(`${med.name} is in ${used.length} organizers, choose one with --organizer`);
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
    values: { name: string; organizer: Organizer; perDay: string; packageSize: number; from: string },
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
    }).$returningId() as [{ id: number }];
    await tx
        .insert(dose)
        .values({ medicationId: id, organizerId: values.organizer.id, startDate: values.from, perDay: values.perDay });
    return findMedication(tx, owner, values.name);
}

/** Change the default package size. */
export async function updateMedication(tx: Tx, med: Medication, values: { packageSize?: number }): Promise<void> {
    if (values.packageSize === undefined) throw new Error('Nothing to change, give --package-size');
    await tx.update(medication).set(values).where(eq(medication.id, med.id));
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
