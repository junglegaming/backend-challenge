/**
 * Migration CLI (runs as the schema owner role).
 *   bun run migrate:up | migrate:down [--step N] | migrate:status
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "./orm-config";

/** Applies all pending migrations, or reverts the last `step` executed ones (default 1). */
export async function runMigrations(
  url: string,
  direction: "up" | "down" = "up",
  step = 1,
): Promise<string[]> {
  const orm = await MikroORM.init(buildOrmConfig({ url, poolMin: 0, poolMax: 2 }));
  try {
    const migrator = orm.migrator;
    if (direction === "up") return (await migrator.up()).map((m) => m.name);
    const executed = await migrator.getExecuted();
    const toRevert = executed
      .slice(-Math.max(1, step))
      .map((m) => m.name)
      .reverse();
    if (toRevert.length === 0) return [];
    return (await migrator.down({ migrations: toRevert })).map((m) => m.name);
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_MIGRATOR_URL (or DATABASE_URL) is required");
    process.exit(2);
  }
  const [command = "up", ...rest] = process.argv.slice(2);
  const stepIdx = rest.indexOf("--step");
  const step = stepIdx >= 0 ? Number(rest[stepIdx + 1]) : undefined;
  try {
    if (command === "status") {
      const orm = await MikroORM.init(buildOrmConfig({ url, poolMin: 0, poolMax: 1 }));
      const executed = await orm.migrator.getExecuted();
      const pending = await orm.migrator.getPending();
      console.log(
        JSON.stringify(
          { executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) },
          null,
          2,
        ),
      );
      await orm.close(true);
    } else if (command === "up" || command === "down") {
      const names = await runMigrations(url, command, command === "down" ? (step ?? 1) : undefined);
      console.log(JSON.stringify({ command, migrations: names }));
    } else {
      console.error(`unknown command "${command}"`);
      process.exit(2);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
