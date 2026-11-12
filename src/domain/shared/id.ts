import { v7 as uuidv7 } from "uuid";

/**
 * Generates a time-ordered UUID (v7). Time ordering keeps B-tree indexes
 * compact and makes ids roughly sortable by creation time.
 */
export function newId(): string {
  return uuidv7();
}

