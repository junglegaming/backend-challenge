import { createHash } from "node:crypto";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/**
 * Deterministic JSON serialisation:
 *  - object keys sorted by UTF-16 code unit order, recursively;
 *  - `undefined` properties omitted (absent and undefined hash the same);
 *  - no insignificant whitespace;
 *  - numbers are rejected: every business field is a string, so a number here is a contract bug.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number")
    throw new TypeError("canonicalJson: numbers are not allowed in hashed payloads");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type { Json };
