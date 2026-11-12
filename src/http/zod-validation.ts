import type { ZodSchema } from "zod";
import { ValidationError } from "../domain/shared/errors";

/**
 * Validates an untrusted input with a Zod schema and throws a structured
 * `ValidationError` (mapped to HTTP 400) when any field is invalid.
 */
export function parseWithSchema<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "root",
      message: issue.message,
    }));
    const summary = details.map((d) => `${d.path}: ${d.message}`).join("; ");
    throw new ValidationError(`Invalid request payload (${summary})`, details);
  }
  return result.data;
}

