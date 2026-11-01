import { addDays, listedEvents, plan, refillAmount, zeroDoseSince, type PlanInput } from '@med/core';
import type { Overview, OverviewEvent } from './types.ts';

export type { Overview, OverviewEvent, OverviewMedication } from './types.ts';

/** How far ahead later pickups and refills are listed; see listedEvents for what always is. */
const LIST_DAYS = 60;
/** A medication no longer taken leaves the stock table this long after its dose became 0. */
const HIDE_AFTER_DAYS = 7;

const tablets = (hundredths: number) => hundredths / 100;

export function overview(input: PlanInput, userName: string): Overview {
    const { statuses, events } = plan(input);
    const until = addDays(input.today, LIST_DAYS);
    const listed: OverviewEvent[] = [];
    const refills = new Map<number, Extract<OverviewEvent, { action: 'refill' }>>();

    for (const event of listedEvents(events, input.today, LIST_DAYS)) {
        if (event.action === 'refill') {
            // One row per organizer, as it is filled in one go: due when its first medication runs
            // empty, and possible once any of them has a container free
            for (const [organizerId, amount] of event.refill!) {
                const box = input.organizers.find((o) => o.id === organizerId)!;
                const due = event.due!.get(organizerId)!;
                const row = refills.get(organizerId) ?? {
                    action: 'refill' as const,
                    organizerId,
                    organizerName: box.name,
                    actionDate: due,
                    availableFrom: event.availableFrom!,
                    runsOut: addDays(due, 1),
                    items: [],
                };
                if (due < row.actionDate) {
                    row.actionDate = due;
                    row.runsOut = addDays(due, 1);
                }
                if (event.availableFrom! < row.availableFrom) row.availableFrom = event.availableFrom!;
                // Once it can be refilled, show what a refill today moves; before that, the planned amount
                const medication = input.medications.find((m) => m.id === event.medicationId)!;
                const now = event.availableFrom! <= input.today ? refillAmount(input, medication, organizerId, input.today) : amount;
                row.items.push({ medicationId: event.medicationId, name: event.medicationName, tablets: tablets(now) });
                refills.set(organizerId, row);
            }
        } else {
            listed.push({
                action: event.action,
                medicationId: event.medicationId,
                medicationName: event.medicationName,
                actionDate: event.actionDate,
                runsOut: event.runsOut,
                packages: event.packages,
                needsRenewal: event.needsRenewal,
                expiresOn: event.expiresOn,
            });
        }
    }
    listed.push(...[...refills.values()].filter((row) => row.actionDate <= until));
    listed.sort((a, b) => a.actionDate.localeCompare(b.actionDate) || (a.action === 'refill' ? -1 : 1));

    return {
        today: input.today,
        user: userName,
        organizers: input.organizers.map(({ id, name }) => ({ id, name })),
        medications: statuses
            .filter(({ medication }) => {
                const since = zeroDoseSince(medication, input.today);
                return since === undefined || addDays(since, HIDE_AFTER_DAYS) > input.today;
            })
            .map(({ medication, doses, stock, tier3 }) => ({
            // A pickup waiting for a new prescription isn't one: the table shows there is none left
            nextPickup: events.find(
                (e) =>
                    e.medicationId === medication.id &&
                    !e.needsRenewal &&
                    (e.action === 'pickup' || e.action === 'pickup-before-expiry'),
            )?.actionDate,
            nextReorder: events.find((e) => e.medicationId === medication.id && e.action === 'contact-doctor')?.actionDate,
            id: medication.id,
            name: medication.name,
            packageSize: medication.packageSize,
            doses: Object.fromEntries([...doses].filter(([, n]) => n > 0).map(([id, n]) => [id, tablets(n)])),
            tier1: Object.fromEntries([...stock.tier1].map(([id, n]) => [id, tablets(n)])),
            tier2: tablets(stock.tier2),
            tier3: tablets(tier3),
        })),
        events: listed,
    };
}
