/**
 * Tablet counts are calculated in hundredths, as integers, so half and quarter tablets add up
 * exactly; the database stores them as DECIMAL(8,2) strings.
 */
export type Hundredths = number;

export function fromDecimal(value: string): Hundredths {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
    return negative ? -amount : amount;
}

export function toDecimal(amount: Hundredths): string {
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 12, 1.5 or 0.25: the shortest way to show a count. */
export function formatTablets(amount: Hundredths): string {
    return toDecimal(amount).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
