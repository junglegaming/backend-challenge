import { MikroORM } from "@mikro-orm/postgresql";
import { databaseOptions } from "../../mikro-orm.config";
import { parseConfiguration } from "../config/config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down")
  throw new Error("Expected migration direction up or down");
const orm = await MikroORM.init(databaseOptions(parseConfiguration(process.env).database));
try {
  if (direction === "up") await orm.migrator.up();
  else await orm.migrator.down();
} finally {
  await orm.close(true);
}
