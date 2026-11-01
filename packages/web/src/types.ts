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
}

export type OverviewEvent =
    | {
          action: 'refill';
          organizerId: number;
          organizerName: string;
          actionDate: string;
          runsOut: string;
          items: { medicationId: number; name: string; tablets: number }[];
      }
    | {
          action: 'pickup' | 'pickup-before-expiry' | 'contact-doctor';
          medicationId: number;
          medicationName: string;
          actionDate: string;
          runsOut: string;
          packages?: number;
          expiresOn?: string;
      };

export interface Overview {
    today: string;
    user: string;
    organizers: { id: number; name: string }[];
    medications: OverviewMedication[];
    events: OverviewEvent[];
}
