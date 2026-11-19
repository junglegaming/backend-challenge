import { createHash } from 'node:crypto';

/** JSON canônico: chaves ordenadas recursivamente, sem espaços, campos undefined omitidos. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio. */
export const payloadHash = (businessFields: Record<string, unknown>): string => sha256(canonicalJson(businessFields));
