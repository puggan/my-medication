#!/usr/bin/env -S node --import tsx
import { parseArgs } from 'node:util';
import { addDays, loadPlanInput, plan } from '@med/core';
import { connectVerified, type Db } from '@med/db';
import { parseDate, parseMoney, parsePositiveInt, parseTablets, parseTier, today } from './input.ts';
import {
    addDrop,
    addMedication,
    addOrganizer,
    addRenew,
    findMedication,
    findOrganizer,
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

  med renew <name> <tablets> --expires YYYY-MM-DD [--date YYYY-MM-DD] [--note <text>]
      A prescription adding tablets to tier 3 on --date (default today), usable until --expires.
      What is left on a prescription when tracking starts is recorded the same way.

  med drop <name> <tier> <tablets> [--date YYYY-MM-DD] [--note <text>]
      Tablets that left tier 1-3 outside the normal flow (lost, broken, expired), dated at the end
      of --date (default today). Tier 1 drops are per --organizer. Negative tablets were found; opening stock is a negative drop
      (put -- after the options so a negative count is not read as one: drop --date D -- Name 1 -28).

  --user <name> and --organizer <name> may be left out while there is only one to choose from.
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
    renew: { argc: 2, run: runRenew },
    drop: { argc: 3, run: runDrop },
};
// Two-word commands take their second word from the positionals
const twoWord = command !== undefined && args[0] !== undefined ? `${command} ${args[0]}` : undefined;
const name = twoWord !== undefined && twoWord in commands ? twoWord : command;
const commandArgs = name === twoWord ? args.slice(1) : args;
const selected = name === undefined ? undefined : commands[name];
if (values.help || !selected || selected.argc !== commandArgs.length) {
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

async function runRenew(db: Db, [name, tablets]: string[]): Promise<number> {
    if (values.expires === undefined) throw new Error('renew needs --expires');
    const input = {
        tablets: parseTablets('tablets', tablets!),
        date: values.date === undefined ? today() : parseDate('--date', values.date),
        expiresOn: parseDate('--expires', values.expires),
        note: values.note,
    };
    await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        await addRenew(tx, owner, await findMedication(tx, owner, name!), input);
    });
    console.log(`${mark} ${name}: ${input.tablets} on prescription from ${input.date}, expires ${input.expiresOn}`);
    return 0;
}

async function runDrop(db: Db, [name, tier, tablets]: string[]): Promise<number> {
    const input = {
        tier: parseTier(tier!),
        tablets: parseTablets('tablets', tablets!, { signed: true }),
        date: values.date === undefined ? today() : parseDate('--date', values.date),
        note: values.note,
    };
    const box = await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        const organizer = input.tier === 1 ? await findOrganizer(tx, owner, values.organizer) : undefined;
        await addDrop(tx, owner, await findMedication(tx, owner, name!), { ...input, organizer });
        return organizer;
    });
    const what = input.tablets.startsWith('-') ? `${input.tablets.slice(1)} found in` : `${input.tablets} dropped from`;
    const where = box === undefined ? `tier ${input.tier}` : `tier 1 (${box.name})`;
    console.log(`${mark} ${name}: ${what} ${where} on ${input.date}`);
    return 0;
}
