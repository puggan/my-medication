import { addDays, daysBetween, weekday } from './dates.ts';
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

/**
 * The pharmacy hands out the next pickup only once this share of the previous one is used at the
 * prescribed dose: 90 tablets at 1 a day can be followed by the next after 60 days.
 */
export const PICKUP_USED_SHARE = 2 / 3;

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
    /** False for a pickup from before tracking: no stock moves, but the 2/3 rule counts from it. */
    countsInStock: boolean;
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
    /** Weekday the organizers are topped up (0 = Sunday); pickups are planned so the cupboard manages it. */
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
    /** refill: the last day the organizer still has tablets, the evening it must be refilled (= actionDate). */
    due?: Map<number, string>;
    /** refill: the first day at least one day fits, from when the refill can be done. */
    availableFrom?: string;
    /** pickup: packages of the default size. */
    packages?: number;
    /** pickup: nothing is left to pick up, so it waits for the new prescription. */
    needsRenewal?: boolean;
    /** pickup and pickup-before-expiry: the first day the 2/3 rule allows it. */
    pickableFrom?: string;
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
    /** The first day the 2/3 rule allows the next pickup, after the last recorded one. */
    pickableFrom?: string;
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
            pickableFrom: meds.lastPickup && meds.pickableAfter(meds.lastPickup.date, meds.lastPickup.tablets),
        });
        events.push(...meds.project(stock));
    }
    events.sort((a, b) => a.actionDate.localeCompare(b.actionDate) || a.medicationName.localeCompare(b.medicationName));
    return { statuses, events };
}

/**
 * The events worth listing: everything within days of today, plus however far ahead every doctor
 * contact, every pickup before expiry, and the next pickup of each medication.
 */
export function listedEvents(events: PlanEvent[], today: string, days: number): PlanEvent[] {
    const until = addDays(today, days);
    const nextPickup = new Set<number>();
    return events.filter((event) => {
        const isPickup = event.action === 'pickup' || event.action === 'pickup-before-expiry';
        const first = isPickup && !nextPickup.has(event.medicationId);
        if (isPickup) nextPickup.add(event.medicationId);
        return event.actionDate <= until || first || event.action === 'contact-doctor' || event.action === 'pickup-before-expiry';
    });
}

/**
 * The day a medication's dose became 0 in every organizer, if it is 0 on date; undefined while it
 * is taken, and for a medication without any dose yet.
 */
export function zeroDoseSince(medication: PlanMedication, date: string): string | undefined {
    const latest = new Map<number, PlanDose>();
    for (const dose of medication.doses) {
        if (dose.startDate > date) continue;
        const current = latest.get(dose.organizerId);
        if (!current || dose.startDate > current.startDate) latest.set(dose.organizerId, dose);
    }
    if (latest.size === 0 || [...latest.values()].some((dose) => dose.perDay > 0)) return undefined;
    return [...latest.values()].reduce((last, dose) => (dose.startDate > last ? dose.startDate : last), '');
}

/**
 * Tablets that top one organizer up to full at the end of date, from the recorded transfers: what a
 * refill done that day moves, early or on time.
 */
export function refillAmount(input: PlanInput, medication: PlanMedication, organizerId: number, date: string): Hundredths {
    const meds = new MedicationPlan(input, medication);
    const box = input.organizers.find((o) => o.id === organizerId);
    if (!box) throw new Error(`No organizer ${organizerId}`);
    return meds.fillUp(meds.history(date), box, date);
}

export interface OrganizerFill {
    /** The last day the organizer is filled for now: its first medication's last day, today at the earliest. */
    filledUntil: string;
    /** Days that fit: filling n of them fills it until filledUntil + n. */
    maxDays: number;
    /** Per medication id, the tablets for filling 1 … maxDays days (index n - 1). */
    amounts: Map<number, Hundredths[]>;
}

/**
 * How a refill of one organizer at the end of date can go, from the recorded transfers: by days,
 * each medication up to the same last day, so the organizer's day slots end together.
 */
export function organizerFill(input: PlanInput, organizerId: number, date: string): OrganizerFill {
    const box = input.organizers.find((o) => o.id === organizerId);
    if (!box) throw new Error(`No organizer ${organizerId}`);
    const held = new Map<number, { plan: MedicationPlan; tablets: Hundredths }>();
    let filledUntil: string | undefined;
    for (const medication of input.medications) {
        const meds = new MedicationPlan(input, medication);
        const perDay = meds.dose(organizerId, addDays(date, 1));
        if (perDay === 0) continue;
        const tablets = Math.max(0, meds.history(date).tier1.get(organizerId) ?? 0);
        held.set(medication.id, { plan: meds, tablets });
        const lastDay = addDays(date, Math.floor(tablets / perDay));
        if (filledUntil === undefined || lastDay < filledUntil) filledUntil = lastDay;
    }
    if (filledUntil === undefined) return { filledUntil: date, maxDays: 0, amounts: new Map() };

    const maxDays = Math.max(0, box.containers * box.containerDays - daysBetween(date, filledUntil));
    const amounts = new Map<number, Hundredths[]>();
    for (const [id, { plan: meds, tablets }] of held) {
        const options: Hundredths[] = [];
        let needed = 0;
        for (let day = 1; day <= daysBetween(date, filledUntil) + maxDays; day++) {
            needed += meds.dose(organizerId, addDays(date, day));
            if (day > daysBetween(date, filledUntil)) options.push(Math.max(0, needed - tablets));
        }
        amounts.set(id, options);
    }
    return { filledUntil, maxDays, amounts };
}

/** Stock of one medication at the end of date, from the recorded transfers alone. */
export function stockAt(input: PlanInput, medication: PlanMedication, date: string): Stock {
    return new MedicationPlan(input, medication).history(date);
}

class MedicationPlan {
    private readonly organizers: PlanOrganizer[];
    /** The latest pickup up to the history's end, found by history(); the 2/3 rule counts from it. */
    lastPickup: { date: string; tablets: Hundredths } | undefined;
    /** First day before today each organizer had room for a refill since its last one, found by history(). */
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

    totalDose(date: string): Hundredths {
        return this.organizers.reduce((sum, box) => sum + this.dose(box.id, date), 0);
    }

    history(until: string): Stock {
        const stock: Stock = { tier1: new Map(this.organizers.map((box) => [box.id, 0])), tier2: 0, lots: [] };
        const sorted = [...this.medication.transfers].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
        const transfers = sorted.filter((t) => t.countsInStock);
        this.overdueRefill.clear();
        // Pickups from before tracking only count for the 2/3 rule
        this.lastPickup = undefined;
        for (const t of sorted) if (t.kind === 'pickup' && !t.countsInStock && t.date <= until) this.lastPickup = { date: t.date, tablets: t.tablets };
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
                if (transfer.kind === 'pickup') this.lastPickup = { date: transfer.date, tablets: transfer.tablets };
            }
            // From today on the projection tracks it
            if (date >= until) continue;
            for (const box of this.organizers) {
                if (!this.overdueRefill.has(box.id) && this.canRefill(stock, box, date)) {
                    this.overdueRefill.set(box.id, date);
                }
            }
        }
        return stock;
    }

    /** The first day the 2/3 rule allows a pickup after one of tablets on date, at that day's dose. */
    pickableAfter(date: string, tablets: Hundredths): string | undefined {
        const perDay = this.totalDose(addDays(date, 1));
        return perDay === 0 ? undefined : addDays(date, Math.ceil((tablets * PICKUP_USED_SHARE) / perDay));
    }

    private drain(stock: Stock, date: string): void {
        for (const box of this.organizers) {
            stock.tier1.set(box.id, (stock.tier1.get(box.id) ?? 0) - this.dose(box.id, date));
        }
    }

    /** Whether at least one more day fits in an organizer at the end of date, so it can be refilled. */
    private canRefill(stock: Stock, box: PlanOrganizer, date: string): boolean {
        const perDay = this.dose(box.id, addDays(date, 1));
        return perDay > 0 && (stock.tier1.get(box.id) ?? 0) <= (box.containers * box.containerDays - 1) * perDay;
    }

    /**
     * Tablets that top an organizer up to full at the end of date. Below 0 it is just empty: the
     * missing doses were never in it, so a count should settle them, not the refill.
     */
    fillUp(stock: Stock, box: PlanOrganizer, date: string): Hundredths {
        let full = 0;
        for (let day = 1; day <= box.containers * box.containerDays; day++) full += this.dose(box.id, addDays(date, day));
        return Math.max(0, full - Math.max(0, stock.tier1.get(box.id) ?? 0));
    }

    /**
     * Each organizer's next refill, from today's stock: due the last day it still has tablets (in the
     * past when it already ran empty), filling it whole, and possible from the first day a day's
     * room is free. One event per organizer, as they are refilled on their own.
     */
    private nextRefills(stock: Stock): PlanEvent[] {
        const { today } = this.input;
        const events: PlanEvent[] = [];
        for (const box of this.organizers) {
            const perDay = this.dose(box.id, addDays(today, 1));
            if (perDay === 0) continue;
            const held = stock.tier1.get(box.id) ?? 0;
            const lastDay = addDays(today, Math.floor(held / perDay));
            let full = 0;
            for (let day = 1; day <= box.containers * box.containerDays; day++) full += this.dose(box.id, addDays(lastDay, day));
            const room = (box.containers * box.containerDays - 1) * perDay;
            events.push({
                action: 'refill',
                medicationId: this.medication.id,
                medicationName: this.medication.name,
                actionDate: lastDay,
                runsOut: addDays(lastDay, 1),
                refill: new Map([[box.id, full]]),
                due: new Map([[box.id, lastDay]]),
                availableFrom: this.overdueRefill.get(box.id) ?? addDays(today, Math.max(0, Math.ceil((held - room) / perDay))),
            });
        }
        return events;
    }

    project(stock: Stock): PlanEvent[] {
        const { today, refillWeekday, pickupWarningDays, renewalLeadDays } = this.input;
        const { id: medicationId, name: medicationName, packageSize } = this.medication;
        const pkg = packageSize * 100;
        const events: PlanEvent[] = [];
        events.push(...this.nextRefills(stock));
        const home = () => [...stock.tier1.values()].reduce((sum, n) => sum + n, stock.tier2);
        const runsOut = (date: string, tablets: Hundredths, perDay: Hundredths) =>
            addDays(date, Math.max(0, Math.floor(tablets / perDay)) + 1);
        // The 2/3 rule: no pickup before nextPickable, which each pickup moves on
        let nextPickable = this.lastPickup && this.pickableAfter(this.lastPickup.date, this.lastPickup.tablets);
        const pickup = (warnOn: string, tablets: Hundredths) => {
            const pickableFrom = nextPickable;
            const actionDate = pickableFrom !== undefined && pickableFrom > warnOn ? pickableFrom : warnOn;
            nextPickable = this.pickableAfter(actionDate, tablets);
            return { actionDate, pickableFrom };
        };

        for (let date = today; date <= addDays(today, HORIZON_DAYS); date = addDays(date, 1)) {
            if (date > today) this.drain(stock, date);
            const perDay = this.totalDose(addDays(date, 1));
            if (perDay === 0 && this.laterDoses(date)) continue;
            if (perDay === 0) break;

            // On its last day, pick up what is left on a prescription rather than lose it, unless the
            // 2/3 rule doesn't allow a pickup before then
            for (const lot of stock.lots) {
                if (lot.expiresOn !== date) continue;
                const packages = pickablePackages(lot.tablets, pkg);
                if (packages === 0 || (nextPickable !== undefined && nextPickable > lot.expiresOn)) continue;
                lot.tablets = Math.max(0, lot.tablets - packages * pkg);
                stock.tier2 += packages * pkg;
                events.push({
                    action: 'pickup-before-expiry',
                    medicationId,
                    medicationName,
                    ...pickup(addDays(date, -pickupWarningDays), packages * pkg),
                    runsOut: addDays(date, 1),
                    packages,
                    expiresOn: lot.expiresOn,
                });
            }

            // The cupboard has to manage a top-up every refill weekday, so pickups are planned for that,
            // whatever day the refill events are due; an organizer running empty sooner is filled then
            const refillDay = weekday(date) === refillWeekday;
            const needs = new Map<number, Hundredths>();
            for (const box of this.organizers) {
                const next = this.dose(box.id, addDays(date, 1));
                const held = stock.tier1.get(box.id) ?? 0;
                if (next > 0 && (held < next || (refillDay && this.canRefill(stock, box, date)))) {
                    needs.set(box.id, this.fillUp(stock, box, date));
                }
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
                        ...pickup(addDays(date, -pickupWarningDays), packages * pkg),
                        runsOut: shortBy,
                        packages,
                    });
                }
                if (stock.tier2 < total) {
                    // Nothing left to pick up: the pickup still happens then, from a new prescription,
                    // which is ordered a lead time before the medication runs out
                    const expired = stock.lots.find((lot) => lot.expiresOn < date && pickablePackages(lot.tablets, pkg) > 0);
                    const emptyOn = runsOut(date, home(), perDay);
                    const renewalPackages = Math.ceil((total - stock.tier2) / pkg);
                    events.push({
                        action: 'pickup',
                        medicationId,
                        medicationName,
                        ...pickup(addDays(date, -pickupWarningDays), renewalPackages * pkg),
                        runsOut: runsOut(date, home(), perDay),
                        packages: renewalPackages,
                        needsRenewal: true,
                    });
                    events.push({
                        action: 'contact-doctor',
                        medicationId,
                        medicationName,
                        actionDate: addDays(emptyOn, -renewalLeadDays),
                        runsOut: emptyOn,
                        expiresOn: expired?.expiresOn,
                    });
                    break;
                }
            }

            for (const [boxId, need] of needs) {
                stock.tier2 -= need;
                stock.tier1.set(boxId, (stock.tier1.get(boxId) ?? 0) + need);
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
