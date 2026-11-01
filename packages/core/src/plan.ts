import { addDays, weekday } from './dates.ts';
import type { Hundredths } from './tablets.ts';

/**
 * Stock calculation for one user, without database access.
 *
 * Every date means the end of that day: first the day's doses leave tier 1, then the day's
 * transfers apply. The history runs over the recorded transfers up to today; the projection
 * then assumes every action is done on time, so the event list shows when each one is due.
 */

/** A prescription can still be picked up while this share of a default package is left on it. */
export const PICKABLE_SHARE = 0.9;

/** How far ahead the projection looks. */
const HORIZON_DAYS = 450;

export interface PlanOrganizer {
    id: number;
    name: string;
    containers: number;
    containerDays: number;
}

export interface PlanDose {
    organizerId: number;
    startDate: string;
    perDay: Hundredths;
}

export interface PlanTransfer {
    id: number;
    kind: 'renew' | 'pickup' | 'refill' | 'drop';
    date: string;
    tablets: Hundredths;
    tier: number | null;
    organizerId: number | null;
    expiresOn: string | null;
}

export interface PlanMedication {
    id: number;
    name: string;
    packageSize: number;
    doses: PlanDose[];
    transfers: PlanTransfer[];
}

export interface PlanInput {
    today: string;
    refillWeekday: number;
    pickupWarningDays: number;
    renewalLeadDays: number;
    organizers: PlanOrganizer[];
    medications: PlanMedication[];
}

/** What is left on one prescription. */
export interface Lot {
    renewId: number;
    tablets: Hundredths;
    expiresOn: string;
}

export interface Stock {
    tier1: Map<number, Hundredths>;
    tier2: Hundredths;
    lots: Lot[];
}

export type EventAction = 'refill' | 'pickup' | 'pickup-before-expiry' | 'contact-doctor';

export interface PlanEvent {
    action: EventAction;
    medicationId: number;
    medicationName: string;
    /** When to act; before today means overdue. */
    actionDate: string;
    /** First day without enough tablets if nothing is done. */
    runsOut: string;
    /** refill: tablets per organizer id. */
    refill?: Map<number, Hundredths>;
    /** pickup: packages of the default size. */
    packages?: number;
    /** pickup-before-expiry and contact-doctor: the prescription concerned. */
    expiresOn?: string;
}

export interface MedicationStatus {
    medication: PlanMedication;
    /** Dose per organizer id today. */
    doses: Map<number, Hundredths>;
    /** Stock at the end of today. */
    stock: Stock;
    /** Tablets on prescriptions that can still be picked up today. */
    tier3: Hundredths;
}

export interface Plan {
    statuses: MedicationStatus[];
    events: PlanEvent[];
}

export function plan(input: PlanInput): Plan {
    const statuses: MedicationStatus[] = [];
    const events: PlanEvent[] = [];
    for (const medication of input.medications) {
        const meds = new MedicationPlan(input, medication);
        const stock = meds.history(input.today);
        statuses.push({
            medication,
            doses: new Map(input.organizers.map((box) => [box.id, meds.dose(box.id, input.today)])),
            stock: cloneStock(stock),
            tier3: pickableTablets(stock.lots, input.today),
        });
        events.push(...meds.project(stock));
    }
    events.sort((a, b) => a.actionDate.localeCompare(b.actionDate) || a.medicationName.localeCompare(b.medicationName));
    return { statuses, events };
}

/** Stock of one medication at the end of date, from the recorded transfers alone. */
export function stockAt(input: PlanInput, medication: PlanMedication, date: string): Stock {
    return new MedicationPlan(input, medication).history(date);
}

class MedicationPlan {
    private readonly organizers: PlanOrganizer[];
    /** First refill weekday per organizer that was due but not done, found by history(). */
    private overdueRefill = new Map<number, string>();

    constructor(
        private readonly input: PlanInput,
        private readonly medication: PlanMedication,
    ) {
        // Only organizers this medication is ever put in
        const used = new Set(medication.doses.map((dose) => dose.organizerId));
        this.organizers = input.organizers.filter((box) => used.has(box.id));
    }

    dose(organizerId: number, date: string): Hundredths {
        let current: PlanDose | undefined;
        for (const dose of this.medication.doses) {
            if (dose.organizerId !== organizerId || dose.startDate > date) continue;
            if (!current || dose.startDate > current.startDate) current = dose;
        }
        return current?.perDay ?? 0;
    }

    private totalDose(date: string): Hundredths {
        return this.organizers.reduce((sum, box) => sum + this.dose(box.id, date), 0);
    }

    history(until: string): Stock {
        const stock: Stock = { tier1: new Map(this.organizers.map((box) => [box.id, 0])), tier2: 0, lots: [] };
        const transfers = [...this.medication.transfers].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
        this.overdueRefill.clear();
        if (transfers.length === 0) return stock;

        // Tracking starts at the end of the first transfer's day, so that day's doses are already taken
        const first = transfers[0]!.date;
        let next = 0;
        for (let date = first; date <= until; date = addDays(date, 1)) {
            if (date > first) this.drain(stock, date);
            for (; next < transfers.length && transfers[next]!.date === date; next++) {
                const transfer = transfers[next]!;
                apply(stock, transfer);
                if (transfer.kind === 'refill') this.overdueRefill.delete(transfer.organizerId!);
            }
            // Today's refill isn't overdue yet; the projection handles it
            if (date >= until || weekday(date) !== this.input.refillWeekday) continue;
            for (const box of this.organizers) {
                if (!this.overdueRefill.has(box.id) && this.refillNeed(stock, box, date) !== undefined) {
                    this.overdueRefill.set(box.id, date);
                }
            }
        }
        return stock;
    }

    private drain(stock: Stock, date: string): void {
        for (const box of this.organizers) {
            stock.tier1.set(box.id, (stock.tier1.get(box.id) ?? 0) - this.dose(box.id, date));
        }
    }

    /**
     * Tablets to top an organizer up to full at the end of date, when a container's room is free;
     * undefined when it isn't due.
     */
    private refillNeed(stock: Stock, box: PlanOrganizer, date: string): Hundredths | undefined {
        const perDay = this.dose(box.id, addDays(date, 1));
        if (perDay === 0) return undefined;
        const held = stock.tier1.get(box.id) ?? 0;
        if (held > (box.containers - 1) * box.containerDays * perDay) return undefined;
        let full = 0;
        for (let day = 1; day <= box.containers * box.containerDays; day++) full += this.dose(box.id, addDays(date, day));
        return Math.max(0, full - held);
    }

    project(stock: Stock): PlanEvent[] {
        const { today, refillWeekday, pickupWarningDays, renewalLeadDays } = this.input;
        const { id: medicationId, name: medicationName, packageSize } = this.medication;
        const pkg = packageSize * 100;
        const events: PlanEvent[] = [];
        let refillShown = false;
        const home = () => [...stock.tier1.values()].reduce((sum, n) => sum + n, stock.tier2);
        const runsOut = (date: string, tablets: Hundredths, perDay: Hundredths) =>
            addDays(date, Math.max(0, Math.floor(tablets / perDay)) + 1);

        for (let date = today; date <= addDays(today, HORIZON_DAYS); date = addDays(date, 1)) {
            if (date > today) this.drain(stock, date);
            const perDay = this.totalDose(addDays(date, 1));
            if (perDay === 0 && this.laterDoses(date)) continue;
            if (perDay === 0) break;

            // On its last day, pick up what is left on a prescription rather than lose it
            for (const lot of stock.lots) {
                if (lot.expiresOn !== date) continue;
                const packages = pickablePackages(lot.tablets, pkg);
                if (packages === 0) continue;
                lot.tablets = Math.max(0, lot.tablets - packages * pkg);
                stock.tier2 += packages * pkg;
                events.push({
                    action: 'pickup-before-expiry',
                    medicationId,
                    medicationName,
                    actionDate: addDays(date, -pickupWarningDays),
                    runsOut: addDays(date, 1),
                    packages,
                    expiresOn: lot.expiresOn,
                });
            }

            if (weekday(date) !== refillWeekday) continue;
            const needs = new Map<number, Hundredths>();
            for (const box of this.organizers) {
                const need = this.refillNeed(stock, box, date);
                if (need !== undefined && need > 0) needs.set(box.id, need);
            }
            const total = [...needs.values()].reduce((sum, n) => sum + n, 0);
            if (total === 0) continue;

            if (stock.tier2 < total) {
                const shortBy = runsOut(date, home(), perDay);
                let packages = 0;
                for (let lot = firstPickable(stock.lots, date, pkg); stock.tier2 < total && lot; lot = firstPickable(stock.lots, date, pkg)) {
                    lot.tablets = Math.max(0, lot.tablets - pkg);
                    stock.tier2 += pkg;
                    packages++;
                }
                if (packages > 0) {
                    events.push({
                        action: 'pickup',
                        medicationId,
                        medicationName,
                        actionDate: addDays(date, -pickupWarningDays),
                        runsOut: shortBy,
                        packages,
                    });
                }
                if (stock.tier2 < total) {
                    // Nothing left to pick up: a new prescription has to be ready by the pickup warning
                    const expired = stock.lots.find((lot) => lot.expiresOn < date && pickablePackages(lot.tablets, pkg) > 0);
                    events.push({
                        action: 'contact-doctor',
                        medicationId,
                        medicationName,
                        actionDate: addDays(date, -pickupWarningDays - renewalLeadDays),
                        runsOut: runsOut(date, home(), perDay),
                        expiresOn: expired?.expiresOn,
                    });
                    break;
                }
            }

            // The first refill may be overdue: it was due on an earlier refill day and never done
            let actionDate = date;
            let emptyOn: string | undefined;
            for (const [boxId, need] of needs) {
                const overdue = refillShown ? undefined : this.overdueRefill.get(boxId);
                if (overdue !== undefined && overdue < actionDate) actionDate = overdue;
                const boxEmpty = runsOut(date, stock.tier1.get(boxId) ?? 0, this.dose(boxId, addDays(date, 1)));
                if (emptyOn === undefined || boxEmpty < emptyOn) emptyOn = boxEmpty;
                stock.tier2 -= need;
                stock.tier1.set(boxId, (stock.tier1.get(boxId) ?? 0) + need);
            }
            if (!refillShown) {
                events.push({
                    action: 'refill',
                    medicationId,
                    medicationName,
                    actionDate,
                    runsOut: emptyOn!,
                    refill: needs,
                });
                refillShown = true;
            }
        }
        return events;
    }

    /** Whether a dose above 0 starts after date. */
    private laterDoses(date: string): boolean {
        return this.medication.doses.some((dose) => dose.startDate > date && dose.perDay > 0);
    }
}

function apply(stock: Stock, transfer: PlanTransfer): void {
    switch (transfer.kind) {
        case 'renew':
            stock.lots.push({ renewId: transfer.id, tablets: transfer.tablets, expiresOn: transfer.expiresOn! });
            stock.lots.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
            break;
        case 'pickup':
            stock.tier2 += transfer.tablets;
            takeFromLots(stock.lots, transfer.date, transfer.tablets);
            break;
        case 'refill':
            stock.tier2 -= transfer.tablets;
            stock.tier1.set(transfer.organizerId!, (stock.tier1.get(transfer.organizerId!) ?? 0) + transfer.tablets);
            break;
        case 'drop':
            if (transfer.tier === 1) {
                stock.tier1.set(transfer.organizerId!, (stock.tier1.get(transfer.organizerId!) ?? 0) - transfer.tablets);
            } else if (transfer.tier === 2) {
                stock.tier2 -= transfer.tablets;
            } else {
                takeFromLots(stock.lots, transfer.date, transfer.tablets);
            }
            break;
    }
}

/** Take tablets from the prescriptions valid on date, the one expiring first first; negative adds back. */
function takeFromLots(lots: Lot[], date: string, tablets: Hundredths): void {
    const valid = lots.filter((lot) => lot.expiresOn >= date);
    if (tablets < 0) {
        if (valid[0]) valid[0].tablets -= tablets;
        return;
    }
    let left = tablets;
    for (const lot of valid) {
        const taken = Math.min(left, Math.max(0, lot.tablets));
        lot.tablets -= taken;
        left -= taken;
        if (left === 0) break;
    }
}

/** Packages that can be picked up from what is left: whole ones, plus one for a 90% remainder. */
function pickablePackages(tablets: Hundredths, pkg: Hundredths): number {
    if (tablets <= 0) return 0;
    const whole = Math.floor(tablets / pkg);
    return whole + (tablets - whole * pkg >= pkg * PICKABLE_SHARE ? 1 : 0);
}

function firstPickable(lots: Lot[], date: string, pkg: Hundredths): Lot | undefined {
    return lots.find((lot) => lot.expiresOn >= date && pickablePackages(lot.tablets, pkg) > 0);
}

function pickableTablets(lots: Lot[], date: string): Hundredths {
    return lots.filter((lot) => lot.expiresOn >= date).reduce((sum, lot) => sum + Math.max(0, lot.tablets), 0);
}

function cloneStock(stock: Stock): Stock {
    return { tier1: new Map(stock.tier1), tier2: stock.tier2, lots: stock.lots.map((lot) => ({ ...lot })) };
}
