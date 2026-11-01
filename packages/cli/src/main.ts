#!/usr/bin/env -S node --import tsx
import { parseArgs } from 'node:util';
import { connectVerified, type Db } from '@med/db';
import { parseDate, parseMoney, parsePositiveInt, parseTablets, parseTier, today } from './input.ts';
import { addDrop, addMedication, findMedication, findUser, listMedications, setDose } from './medication.ts';
import { inTransaction } from './transaction.ts';

const USAGE = `Usage:
  med medication list [--date YYYY-MM-DD]
      List medications with the dose in effect on --date (default today).

  med medication add <name> --per-day <tablets> --package-size <tablets> [--price <kr>] [--from YYYY-MM-DD]
      Add a medication with its first dose, starting --from (default today).

  med dose set <name> <tablets per day> [--from YYYY-MM-DD]
      Change the dose from --from (default today) on. 0 means the medication is no longer taken.

  med drop <name> <tier> <tablets> [--date YYYY-MM-DD] [--note <text>]
      Tablets that left tier 1-3 outside the normal flow (lost, broken, expired), dated at the end
      of --date (default today). Negative tablets were found; opening stock is a negative drop
      (put -- after the options so a negative count is not read as one: drop --date D -- Name 1 -28).

  --user <name> picks whose medications to use; it may be left out while only one user exists.
  --dry-run checks everything, then rolls back instead of saving.`;

const { positionals, values } = parseArgs({
    allowPositionals: true,
    allowNegative: false,
    options: {
        user: { type: 'string' },
        date: { type: 'string' },
        from: { type: 'string' },
        'per-day': { type: 'string' },
        'package-size': { type: 'string' },
        price: { type: 'string' },
        note: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
    },
});
const [command, ...args] = positionals;
const dryRun = values['dry-run'];
const mark = dryRun ? '○' : '✓';

const commands: Record<string, { argc: number; run: (db: Db, args: string[]) => Promise<number> }> = {
    'medication list': { argc: 0, run: runMedicationList },
    'medication add': { argc: 1, run: runMedicationAdd },
    'dose set': { argc: 2, run: runDoseSet },
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

async function runMedicationList(db: Db): Promise<number> {
    const date = values.date === undefined ? today() : parseDate('--date', values.date);
    const owner = await findUser(db, values.user);
    const rows = await listMedications(db, owner, date);
    const width = Math.max(4, ...rows.map(({ med }) => med.name.length));
    console.log(`${'Name'.padEnd(width)}  Per day  Package     Price`);
    for (const { med, perDay } of rows) {
        console.log(
            `${med.name.padEnd(width)}  ${(perDay ?? '-').padStart(7)}  ${String(med.packageSize).padStart(7)}  ` +
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
    await inTransaction(db, dryRun, async (tx) => addMedication(tx, await findUser(tx, values.user), input));
    console.log(`${mark} Added ${input.name}: ${input.perDay}/day from ${input.from}, package of ${input.packageSize}`);
    return 0;
}

async function runDoseSet(db: Db, [name, perDay]: string[]): Promise<number> {
    const tablets = parseTablets('tablets per day', perDay!);
    const from = values.from === undefined ? today() : parseDate('--from', values.from);
    await inTransaction(db, dryRun, async (tx) => {
        const med = await findMedication(tx, await findUser(tx, values.user), name!);
        await setDose(tx, med, tablets, from);
    });
    const what = Number(tablets) === 0 ? 'no longer taken' : `${tablets}/day`;
    console.log(`${mark} ${name} ${what} from ${from}`);
    return 0;
}

async function runDrop(db: Db, [name, tier, tablets]: string[]): Promise<number> {
    const input = {
        tier: parseTier(tier!),
        tablets: parseTablets('tablets', tablets!, { signed: true }),
        date: values.date === undefined ? today() : parseDate('--date', values.date),
        note: values.note,
    };
    await inTransaction(db, dryRun, async (tx) => {
        const owner = await findUser(tx, values.user);
        await addDrop(tx, owner, await findMedication(tx, owner, name!), input);
    });
    const what = input.tablets.startsWith('-') ? `${input.tablets.slice(1)} found in` : `${input.tablets} dropped from`;
    console.log(`${mark} ${name}: ${what} tier ${input.tier} on ${input.date}`);
    return 0;
}
