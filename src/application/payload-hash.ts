import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted lexicographically (recursively), no
 * whitespace, `undefined` members dropped. Arrays keep their order.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

/** Lowercase hex SHA-256 of the canonical JSON. */
export const sha256Canonical = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
