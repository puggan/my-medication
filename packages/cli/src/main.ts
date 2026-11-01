#!/usr/bin/env -S node --import tsx
import { parseArgs } from 'node:util';
import {
    addDays,
    formatTablets,
    fromDecimal,
    loadPlanInput,
    plan,
    recordCount,
    recordDrop,
    recordPickup,
    recordRefill,
    recordRenew,
} from '@med/core';
import { connectVerified, type Db } from '@med/db';
import { parseDate, parseMoney, parsePositiveInt, parseTablets, parseTier, today } from './input.ts';
import {
    addMedication,
    addOrganizer,
    findMedication,
    findOrganizer,
    findOrganizerFor,
    findUser,
    listMedications,
    listOrganizers,
    setDose,
    updateMedication,
} from './medication.ts';
import { eventTable, stockTable } from './report.ts';
import { inTransaction } from './transaction.ts';

const USAGE = `Usage:
  med stock [--date YYYY-MM-DD]
      Dose and stock per tier at the end of --date (default today).

  med events [--days 60] [--date YYYY-MM-DD]
      Actions due within --days of --date (default today): the next refill per medication, pickups,
      and every doctor contact and expiry however far ahead.

  med organizer list
  med organizer add <name> --containers <n> [--container-days 7]
      Pill organizers for one time of day, e.g. "morning" with 2 weekly containers. Each is
      refilled once a container is empty, back up to containers × container days.

  med medication list [--date YYYY-MM-DD]
      List medications with the dose per organizer in effect on --date (default today).

  med medication add <name> --per-day <tablets> --package-size <tablets> [--price <kr>] [--from YYYY-MM-DD]
      Add a medication with its first dose in --organizer, starting --from (default today).

  med medication set <name> [--package-size <tablets>] [--price <kr>]
      Change the default package size or price.

  med dose set <name> <tablets per day> [--from YYYY-MM-DD]
      Change the dose in --organizer from --from (default today) on. 0 ends the medication there;
      a medication taken morning and evening has a dose in both organizers.

  med refill [<name>] [--date YYYY-MM-DD]
      Record the refills due by --date (default today), of every medication or only <name>, with
      the amounts med events suggests. --tablets (with --organizer for a medication in several)
      records one other amount instead.

  med pickup <name> [--packages 1] [--package-size <tablets>] [--price <kr>] [--date YYYY-MM-DD]
      Packages picked up at the pharmacy; the package size defaults to the medication's.

  med renew <name> <tablets> --expires YYYY-MM-DD [--package-size <tablets>] [--date YYYY-MM-DD] [--note <text>]
      A prescription adding tablets to tier 3 on --date (default today), usable until --expires.
      A --package-size becomes the medication's default. What is left on a prescription when
      tracking starts is recorded the same way.

  med count <name> <tier> <tablets> [--date YYYY-MM-DD] [--drop]
      What tier 1-3 actually held at the end of --date (default today), compared with the
      calculation. Tier 1 counts are per --organizer. --drop also records the difference as a drop.

  med drop <name> <tier> <tablets> [--date YYYY-MM-DD] [--note <text>]
      Tablets that left tier 1-3 outside the normal flow (lost, broken, expired), dated at the end
      of --date (default today). Tier 1 drops are per --organizer. Negative tablets were found;
      opening stock is a negative drop (put -- after the options so a negative count is not read
      as one: drop --date D -- Name 1 -28).

  --user <name> may be left out while there is only one user, and --organizer <name> while the
  medication is only in one organizer.
  --dry-run checks everything, then rolls back instead of saving.`;

const { positionals, values } = parseArgs({
    allowPositionals: true,
    allowNegative: false,
    options: {
        user: { type: 'string' },
        organizer: { type: 'string' },
        containers: { type: 'string' },
        'container-days': { type: 'string', default: '7' },
        date: { type: 'string' },
        from: { type: 'string' },
        'per-day': { type: 'string' },
        'package-size': { type: 'string' },
        price: { type: 'string' },
        note: { type: 'string' },
        expires: { type: 'string' },
        days: { type: 'string', default: '60' },
        tablets: { type: 'string' },
        packages: { type: 'string', default: '1' },
        drop: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
    },
});
const [command, ...args] = positionals;
const dryRun = values['dry-run'];
const mark = dryRun ? '○' : '✓';

const commands: Record<string, { argc: number; run: (db: Db, args: string[]) => Promise<number> }> = {
    stock: { argc: 0, run: runStock },
    events: { argc: 0, run: runEvents },
    'organizer list': { argc: 0, run: runOrganizerList },
    'organizer add': { argc: 1, run: runOrganizerAdd },
    'medication list': { argc: 0, run: runMedicationList },
    'medication add': { argc: 1, run: runMedicationAdd },
    'medication set': { argc: 1, run: runMedicationSet },
    'dose set': { argc: 2, run: runDoseSet },
    refill: { argc: -1, run: runRefill },
    pickup: { argc: 1, run: runPickup },
    renew: { argc: 2, run: runRenew },
    count: { argc: 3, run: runCount },
    drop: { argc: 3, run: runDrop },
};
// Two-word commands take their second word from the positionals
const twoWord = command !== undefined && args[0] !== undefined ? `${command} ${args[0]}` : undefined;
const name = twoWord !== undefined && twoWord in commands ? twoWord : command;
const commandArgs = name === twoWord ? args.slice(1) : args;
const selected = name === undefined ? undefined : commands[name];
// argc -1 takes an optional single argument
const argcOk = selected && (selected.argc === -1 ? commandArgs.length <= 1 : selected.argc === commandArgs.length);
if (values.help || !selected || !argcOk) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
}

let db: Db;
try {
    db = await connectVerified();
} catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
}
try {
    process.exitCode = await selected.run(db, commandArgs);
} catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.$client.end();
}

async function runStock(db: Db): Promise<number> {
    const input = await loadPlanInput(db, await findUser(db, values.user), values.date && parseDate('--date', values.date));
    for (const line of stockTable(plan(input), input.organizers)) console.log(line);
    return 0;
}

async function runEvents(db: Db): Promise<number> {
    const input = await loadPlanInput(db, await findUser(db, values.user), values.date && parseDate('--date', values.date));
    const until = addDays(input.today, parsePositiveInt('--days', values.days));
    const events = plan(input).events.filter(
        (event) => event.actionDate <= until || event.action === 'contact-doctor' || event.action === 'pickup-before-expiry',
    );
    for (const line of eventTable(events, input.organizers, input.today)) console.log(line);
    return 0;
}

async function runOrganizerList(db: Db): Promise<number> {
    for (const box of await listOrganizers(db, await findUser(db, values.user))) {
        console.log(`${box.name}: ${box.containers} × ${box.containerDays} days`);
    }
    return 0;
}

async function runOrganizerAdd(db: Db, [name]: string[]): Promise<number> {
    if (values.containers === undefined) throw new Error('organizer add needs --containers');
    const input = {
        name: name!,
        containers: parsePositiveInt('--containers', values.containers),
        containerDays: parsePositiveInt('--container-days', values['container-days']),
    };
    await inTransaction(db, dryRun, async (tx) => addOrganizer(tx, await findUser(tx, values.user), input));
    console.log(`${mark} Added organizer ${input.name}: ${input.containers} × ${input.containerDays} days`);
    return 0;
}

async function runMedicationList(db: Db): Promise<number> {
    const date = values.date === undefined ? today() : parseDate('--date', values.date);
    const owner = await findUser(db, values.user);
    const organizers = await listOrganizers(db, owner);
    const rows = await listMedications(db, owner, date);
    const width = Math.max(4, ...rows.map(({ med }) => med.name.length));
    const boxWidths = organizers.map((box) => Math.max(7, box.name.length));
    console.log(
        `${'Name'.padEnd(width)}  ${organizers.map((box, i) => box.name.padStart(boxWidths[i]!)).join('  ')}  Package     Price`,
    );
    for (const { med, doses } of rows) {
        const perBox = organizers.map((box, i) => (doses.get(box.id) ?? '-').padStart(boxWidths[i]!));
        console.log(
            `${med.name.padEnd(width)}  ${perBox.join('  ')}  ${String(med.packageSize).padStart(7)}  ` +
                `${(med.packagePrice ?? '-').padStart(8)}`,
        );
    }
    return 0;
}

async function runMedicationAdd(db: Db, [name]: string[]): Promise<number> {
    if (values['per-day'] === undefined || values['package-size'] === undefined) {
        throw new Error('medication add needs --per-day and --package-size');
    }
    const input = {
        name: name!,
        perDay: parseTablets('--per-day', values['per-day']),
        packageSize: parsePositiveInt('--package-size', values['package-size']),
        packagePrice: values.price === undefined ? undefined : parseMoney('--price', values.price),
        from: values.from === undefined ? today() : parseDate('--from', values.from),
    };
    const box = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        const organizer = await findOrganizer(tx, owner, values.organizer);
        await addMedication(tx, owner, { ...input, organizer });
        return organizer;
    });
    console.log(
        `${mark} Added ${input.name}: ${input.perDay}/day in ${box.name} from ${input.from}, package of ${input.packageSize}`,
    );
    return 0;
}

async function runMedicationSet(db: Db, [name]: string[]): Promise<number> {
    const input = {
        packageSize: values['package-size'] === undefined ? undefined : parsePositiveInt('--package-size', values['package-size']),
        packagePrice: values.price === undefined ? undefined : parseMoney('--price', values.price),
    };
    await inTransaction(db, dryRun, async (tx) => {
        await updateMedication(tx, await findMedication(tx, await findUser(tx, values.user), name!), input);
    });
    const changes = [
        input.packageSize === undefined ? undefined : `package of ${input.packageSize}`,
        input.packagePrice === undefined ? undefined : `price ${input.packagePrice}`,
    ].filter((change) => change !== undefined);
    console.log(`${mark} ${name}: ${changes.join(', ')}`);
    return 0;
}

async function runDoseSet(db: Db, [name, perDay]: string[]): Promise<number> {
    const tablets = parseTablets('tablets per day', perDay!);
    const from = values.from === undefined ? today() : parseDate('--from', values.from);
    const box = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        const organizer = await findOrganizer(tx, owner, values.organizer);
        await setDose(tx, await findMedication(tx, owner, name!), organizer, tablets, from);
        return organizer;
    });
    const what = Number(tablets) === 0 ? 'no longer taken' : `${tablets}/day`;
    console.log(`${mark} ${name} ${what} in ${box.name} from ${from}`);
    return 0;
}

async function runRefill(db: Db, [name]: string[]): Promise<number> {
    const date = values.date === undefined ? today() : parseDate('--date', values.date);
    if (values.tablets !== undefined && name === undefined) throw new Error('--tablets needs a medication name');
    const done = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        if (values.tablets !== undefined) {
            const med = await findMedication(tx, owner, name!);
            const box = await findOrganizerFor(tx, owner, med, values.organizer);
            const tablets = fromDecimal(parseTablets('--tablets', values.tablets));
            await recordRefill(tx, owner, med, { amounts: new Map([[box.id, tablets]]), date });
            return [`${name}: ${formatTablets(tablets)} ${box.name}`];
        }
        const input = await loadPlanInput(tx, owner, date);
        const due = plan(input).events.filter(
            (event) => event.action === 'refill' && event.actionDate <= date && (name === undefined || event.medicationName === name),
        );
        if (due.length === 0) throw new Error(`No refill due by ${date}${name === undefined ? '' : ` for ${name}`}`);
        const lines: string[] = [];
        for (const event of due) {
            await recordRefill(tx, owner, await findMedication(tx, owner, event.medicationName), { amounts: event.refill!, date });
            const amounts = [...event.refill!].map(
                ([id, n]) => `${formatTablets(n)} ${input.organizers.find((box) => box.id === id)!.name}`,
            );
            lines.push(`${event.medicationName}: ${amounts.join(' + ')}`);
        }
        return lines;
    });
    for (const line of done) console.log(`${mark} Refilled ${line} on ${date}`);
    return 0;
}

async function runPickup(db: Db, [name]: string[]): Promise<number> {
    const date = values.date === undefined ? today() : parseDate('--date', values.date);
    const packages = parsePositiveInt('--packages', values.packages);
    const price = values.price === undefined ? undefined : parseMoney('--price', values.price);
    const size = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        const med = await findMedication(tx, owner, name!);
        const packageSize =
            values['package-size'] === undefined ? med.packageSize : parsePositiveInt('--package-size', values['package-size']);
        await recordPickup(tx, owner, med, { packages, packageSize, price, date, note: values.note });
        return packageSize;
    });
    console.log(`${mark} ${name}: picked up ${packages} × ${size} = ${packages * size} tablets on ${date}`);
    return 0;
}

async function runRenew(db: Db, [name, tablets]: string[]): Promise<number> {
    if (values.expires === undefined) throw new Error('renew needs --expires');
    const input = {
        tablets: fromDecimal(parseTablets('tablets', tablets!)),
        date: values.date === undefined ? today() : parseDate('--date', values.date),
        expiresOn: parseDate('--expires', values.expires),
        packageSize:
            values['package-size'] === undefined ? undefined : parsePositiveInt('--package-size', values['package-size']),
        note: values.note,
    };
    await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        await recordRenew(tx, owner, await findMedication(tx, owner, name!), input);
    });
    console.log(`${mark} ${name}: ${tablets} on prescription from ${input.date}, expires ${input.expiresOn}`);
    return 0;
}

async function runCount(db: Db, [name, tier, tablets]: string[]): Promise<number> {
    const input = {
        tier: parseTier(tier!),
        tablets: fromDecimal(parseTablets('tablets', tablets!)),
        date: values.date === undefined ? today() : parseDate('--date', values.date),
    };
    const { result, where } = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        const med = await findMedication(tx, owner, name!);
        const box = input.tier === 1 ? await findOrganizerFor(tx, owner, med, values.organizer) : undefined;
        const result = await recordCount(tx, owner, med, { ...input, organizerId: box?.id });
        if (values.drop && result.missing !== 0) {
            await recordDrop(tx, owner, med, {
                tier: input.tier,
                organizerId: box?.id,
                tablets: result.missing,
                date: input.date,
                note: 'Settles a count',
            });
        }
        return { result, where: box === undefined ? `tier ${input.tier}` : `tier 1 (${box.name})` };
    });
    const { calculated, missing } = result;
    const difference =
        missing === 0 ? 'matches' : `${formatTablets(Math.abs(missing))} ${missing > 0 ? 'missing' : 'extra'}`;
    const settled = values.drop && missing !== 0 ? ', dropped to match' : '';
    console.log(
        `${mark} ${name} ${where} on ${input.date}: counted ${formatTablets(input.tablets)}, ` +
            `calculated ${formatTablets(calculated)}: ${difference}${settled}`,
    );
    return missing !== 0 && !values.drop ? 1 : 0;
}

async function runDrop(db: Db, [name, tier, tablets]: string[]): Promise<number> {
    const input = {
        tier: parseTier(tier!),
        tablets: fromDecimal(parseTablets('tablets', tablets!, { signed: true })),
        date: values.date === undefined ? today() : parseDate('--date', values.date),
        note: values.note,
    };
    const box = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        const med = await findMedication(tx, owner, name!);
        const organizer = input.tier === 1 ? await findOrganizerFor(tx, owner, med, values.organizer) : undefined;
        await recordDrop(tx, owner, med, { ...input, organizerId: organizer?.id });
        return organizer;
    });
    const amount = formatTablets(Math.abs(input.tablets));
    const what = input.tablets < 0 ? `${amount} found in` : `${amount} dropped from`;
    const where = box === undefined ? `tier ${input.tier}` : `tier 1 (${box.name})`;
    console.log(`${mark} ${name}: ${what} ${where} on ${input.date}`);
    return 0;
}
