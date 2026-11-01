import { daysBetween, formatTablets, type Plan, type PlanEvent, type PlanOrganizer } from '@med/core';

const ACTIONS: Record<PlanEvent['action'], string> = {
    refill: 'Refill',
    pickup: 'Pick up',
    'pickup-before-expiry': 'Pick up before expiry',
    'contact-doctor': 'Contact doctor',
};

function table(header: string[], rows: string[][], rightAligned: Set<number>): string[] {
    const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
    const line = (cells: string[]) =>
        cells.map((cell, i) => (rightAligned.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join('  ').trimEnd();
    return [line(header), ...rows.map(line)];
}

/** Medication, dose per organizer, tier 1 per organizer, tier 2 and tier 3 at the end of today. */
export function stockTable({ statuses }: Plan, organizers: PlanOrganizer[]): string[] {
    const header = [
        'Medication',
        ...organizers.map((box) => `${box.name}/day`),
        ...organizers.map((box) => `T1 ${box.name}`),
        'T2',
        'T3',
        'T3 pkg',
    ];
    const rows = statuses.map(({ medication, doses, stock, tier3 }) => [
        medication.name,
        ...organizers.map((box) => (doses.get(box.id) ? formatTablets(doses.get(box.id)!) : '-')),
        ...organizers.map((box) => (stock.tier1.has(box.id) ? formatTablets(stock.tier1.get(box.id)!) : '-')),
        formatTablets(stock.tier2),
        formatTablets(tier3),
        (tier3 / 100 / medication.packageSize).toFixed(2),
    ]);
    return table(header, rows, new Set(header.map((_, i) => i).filter((i) => i > 0)));
}

export function describeEvent(event: PlanEvent, organizers: PlanOrganizer[]): string {
    switch (event.action) {
        case 'refill':
            return [...event.refill!]
                .map(([id, n]) => `${formatTablets(n)} ${organizers.find((box) => box.id === id)?.name ?? id}`)
                .join(' + ');
        case 'pickup':
            return `${event.packages} package${event.packages === 1 ? '' : 's'}${event.needsRenewal ? ', from the new prescription' : ''}`;
        case 'pickup-before-expiry':
            return `${event.packages} package${event.packages === 1 ? '' : 's'}, prescription expires ${event.expiresOn}`;
        case 'contact-doctor':
            return event.expiresOn ? `prescription expired ${event.expiresOn}` : 'prescription used up';
    }
}

export function eventTable(events: PlanEvent[], organizers: PlanOrganizer[], today: string): string[] {
    const rows = events.map((event) => {
        const days = daysBetween(today, event.actionDate);
        return [
            event.actionDate,
            days < 0 ? `${-days}d late` : days === 0 ? 'today' : `in ${days}d`,
            event.medicationName,
            ACTIONS[event.action],
            describeEvent(event, organizers),
            event.runsOut,
        ];
    });
    return table(['Action date', 'When', 'Medication', 'Action', 'Details', 'Runs out'], rows, new Set([1]));
}
