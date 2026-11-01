/** Calendar dates as YYYY-MM-DD strings; all arithmetic is done in UTC so there are no DST gaps. */

export const TIME_ZONE = 'Europe/Stockholm';

/** Today in Sweden, whatever time zone the server runs in. */
export function today(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: TIME_ZONE });
}

export function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}
