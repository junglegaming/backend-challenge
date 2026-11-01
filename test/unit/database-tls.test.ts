import { expect, test } from "bun:test";
import { databaseOptions } from "../../mikro-orm.config";

const database = {
  host: "postgres",
  port: 5432,
  dbName: "wagering",
  user: "wagering",
  password: "local-test-only",
};

test("local database options omit TLS and keep the broken-connection pool hook", () => {
  const options = databaseOptions(database);
  if (!options.driverOptions) throw new Error("Missing database driver options");
  expect(Object.hasOwn(options.driverOptions, "ssl")).toBe(false);
  expect(typeof options.driverOptions.onPoolCreated).toBe("function");
});

test("an unreadable configured CA fails safely rather than disabling certificate verification", () => {
  expect(() =>
    databaseOptions({ ...database, sslCaFile: "/nonexistent-wagering-test-ca.pem" }),
  ).toThrow("Cannot read DB_SSL_CA_FILE");
});
