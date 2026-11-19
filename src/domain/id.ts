/** UUIDv7: ordenável por tempo, bom para índices B-tree. */
export const newId = (): string => Bun.randomUUIDv7();
