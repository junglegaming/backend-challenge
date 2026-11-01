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
  AUTH_ISSUER: "http://keycloak:8080/realms/wagering",
  AUTH_JWKS_URL: "http://keycloak:8080/realms/wagering/protocol/openid-connect/certs",
};

describe("startup configuration", () => {
  test("omits static credentials for the AWS role chain and preserves complete local credentials", () => {
    const role = parseConfiguration({
      ...configuration,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    });
    expect(Object.hasOwn(role.sqs, "credentials")).toBe(false);
    expect(parseConfiguration(configuration).sqs.credentials).toEqual({
      accessKeyId: "local",
      secretAccessKey: "local",
    });
    expect(
      Object.hasOwn(
        parseConfiguration({ ...configuration, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
          .sqs,
        "credentials",
      ),
    ).toBe(false);
  });
  test.each([
    { AWS_ACCESS_KEY_ID: undefined },
    { AWS_SECRET_ACCESS_KEY: undefined },
    { AWS_ACCESS_KEY_ID: "" },
    { AWS_SECRET_ACCESS_KEY: " " },
  ])("rejects an incomplete static credential pair without disclosing it", (missing) => {
    expect(() => parseConfiguration({ ...configuration, ...missing })).toThrow(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be supplied together",
    );
  });
  test("queue creation and database TLS keep the local defaults and require explicit opt-ins", () => {
    const local = parseConfiguration(configuration);
    expect(local.bootstrapCreateQueues).toBe(true);
    expect(Object.hasOwn(local.database, "sslCaFile")).toBe(false);
    const aws = parseConfiguration({
      ...configuration,
      BOOTSTRAP_CREATE_QUEUES: "false",
      DB_SSL_CA_FILE: "/public-ca.pem",
    });
    expect(aws.bootstrapCreateQueues).toBe(false);
    expect(aws.database.sslCaFile).toBe("/public-ca.pem");
    expect(() => parseConfiguration({ ...configuration, DB_SSL_CA_FILE: " " })).toThrow(
      "DB_SSL_CA_FILE",
    );
  });
  test.each(["", "0", "1", "FALSE", "no"])(
    "rejects an ambiguous queue ownership flag %s",
    (value) => {
      expect(() =>
        parseConfiguration({ ...configuration, BOOTSTRAP_CREATE_QUEUES: value }),
      ).toThrow("Invalid configuration: BOOTSTRAP_CREATE_QUEUES");
    },
  );
  test("test crash barriers cannot be enabled outside the test environment", () => {
    expect(() =>
      parseConfiguration({
        ...configuration,
        NODE_ENV: "production",
        TEST_SYNC_POINTS: "consumer.before_commit",
      }),
    ).toThrow("TEST_SYNC_POINTS requires NODE_ENV=test");
    expect(
      parseConfiguration({
        ...configuration,
        NODE_ENV: "test",
        TEST_SYNC_POINTS: "consumer.before_commit",
        TEST_SYNC_MATCH: "message",
      }).sync.points,
    ).toEqual(["consumer.before_commit"]);
  });
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
  test.each(["AUTH_ISSUER", "AUTH_JWKS_URL"])("requires an HTTP identity URL for %s", (name) => {
    expect(() => parseConfiguration({ ...configuration, [name]: undefined })).toThrow(
      `Missing configuration: ${name}`,
    );
    expect(() => parseConfiguration({ ...configuration, [name]: "file:///invalid" })).toThrow(
      `Invalid configuration: ${name}`,
    );
  });
});
