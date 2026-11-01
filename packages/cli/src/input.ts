/** Parsers for CLI arguments; each throws a message meant for the user. */

/** Today in local time as YYYY-MM-DD. */
export function today(): string {
    return new Date().toLocaleDateString('sv-SE');
}

export function parseDate(name: string, value: string): string {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`${name} must be a date as YYYY-MM-DD, got "${value}"`);
    }
    return value;
}

/** Tablet count with at most two decimals, returned as the decimal string stored in the database. */
export function parseTablets(name: string, value: string, { signed = false } = {}): string {
    const pattern = signed ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;
    if (!pattern.test(value)) throw new Error(`${name} must be a number of tablets (at most 2 decimals), got "${value}"`);
    return value;
}

export function parseMoney(name: string, value: string): string {
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`${name} must be an amount like 125 or 125.50, got "${value}"`);
    return value;
}

export function parsePositiveInt(name: string, value: string): number {
    const number = Number(value);
    if (!/^\d+$/.test(value) || number < 1) throw new Error(`${name} must be a whole number above 0, got "${value}"`);
    return number;
}

export function parseTier(value: string): 1 | 2 | 3 {
    if (value !== '1' && value !== '2' && value !== '3') throw new Error(`tier must be 1, 2 or 3, got "${value}"`);
    return Number(value) as 1 | 2 | 3;
}
