import { describe, expect, test } from "bun:test";
import { parseConfiguration } from "../../src/config/config";

const configuration = {
  DB_HOST: "postgres",
  DB_NAME: "wagering",
  DB_USER: "wagering",
  DB_PASSWORD: "test-local-only",
  SQS_ENDPOINT: "http://ministack:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "local",
  AWS_SECRET_ACCESS_KEY: "local",
};

describe("startup configuration", () => {
  test("parses role and numeric ports without implicit environment defaults for dependencies", () => {
    const result = parseConfiguration({ ...configuration, APP_ROLE: "worker", DB_PORT: "5433" });
    expect(result.role).toBe("worker");
    expect(result.database.port).toBe(5433);
    expect(result.port).toBe(3000);
  });
  test.each(["0", "65536", "1.5", "invalid", ""])("rejects invalid port %s", (PORT) => {
    expect(() => parseConfiguration({ ...configuration, PORT })).toThrow(
      "Invalid configuration: PORT",
    );
  });
  test("rejects missing configuration without echoing sensitive values", () => {
    expect(() => parseConfiguration({ ...configuration, DB_PASSWORD: undefined })).toThrow(
      "Missing configuration: DB_PASSWORD",
    );
  });
  test("rejects unsupported process roles and endpoint protocols", () => {
    expect(() => parseConfiguration({ ...configuration, APP_ROLE: "unknown" })).toThrow("APP_ROLE");
    expect(() => parseConfiguration({ ...configuration, SQS_ENDPOINT: "file:///secret" })).toThrow(
      "SQS_ENDPOINT",
    );
  });
});
