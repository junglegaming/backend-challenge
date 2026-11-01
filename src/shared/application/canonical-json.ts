import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, object[key]]),
      );
    }
    return item;
  });
  if (json === undefined) throw new Error("Value cannot be represented as canonical JSON");
  return json;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
