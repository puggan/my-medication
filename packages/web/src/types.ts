/** Shared with the client, so this file imports nothing. */

/** JSON shapes sent to the client; tablet counts are plain numbers, so 1.5 is a tablet and a half. */

export interface OverviewMedication {
    id: number;
    name: string;
    packageSize: number;
    /** Per organizer id. */
    doses: Record<number, number>;
    tier1: Record<number, number>;
    tier2: number;
    tier3: number;
    /** Next pickup of any kind and next doctor contact, however far ahead. */
    nextPickup?: string;
    nextReorder?: string;
    /** The first day the 2/3 rule allows the next pickup, after the last recorded one. */
    pickableFrom?: string;
}

export type OverviewEvent =
    | {
          action: 'refill';
          organizerId: number;
          organizerName: string;
          /** The last day the organizer still has tablets: refill it that evening at the latest. */
          actionDate: string;
          /** From when it can be refilled, a container being free. */
          availableFrom: string;
          /** Once it can be refilled: refilling n days fills it until filledUntil + n, n up to maxDays. */
          fill?: { filledUntil: string; maxDays: number };
          runsOut: string;
          /** tablets is a full refill; with fill, byDays[n - 1] is the amount for n days. */
          items: { medicationId: number; name: string; tablets: number; byDays?: number[] }[];
      }
    | {
          action: 'pickup' | 'pickup-before-expiry' | 'contact-doctor';
          medicationId: number;
          medicationName: string;
          actionDate: string;
          runsOut: string;
          packages?: number;
          /** A pickup from the new prescription, which has to be renewed first. */
          needsRenewal?: boolean;
          /** The first day the 2/3 rule allows the pickup. */
          pickableFrom?: string;
          expiresOn?: string;
      };

export interface Overview {
    today: string;
    user: string;
    organizers: { id: number; name: string }[];
    medications: OverviewMedication[];
    events: OverviewEvent[];
}
