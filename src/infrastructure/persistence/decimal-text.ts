/** PostgreSQL NUMERIC must be delivered as an exact decimal string, never a JS number. */
export function decimalText(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new TypeError('Expected an exact decimal string with at most two fractional digits');
  }
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
