import type { z } from "zod";
import { ValidationError } from "../../shared/application/errors";

/** Parses input with a zod schema; failures become a 400 ValidationError with field-level issues. */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(`invalid ${what}`, {
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
