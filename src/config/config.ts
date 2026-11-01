import { Injectable } from "@nestjs/common";

export type AppRole = "api" | "consumer" | "worker";

export function parseConfiguration(env: Record<string, string | undefined>) {
  function required(name: string): string {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing configuration: ${name}`);
    return value;
  }
  function port(name: string, fallback: string): number {
    const value = env[name] ?? fallback;
    if (!/^\d+$/.test(value) || +value < 1 || +value > 65535) {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return +value;
  }
  const role = env.APP_ROLE ?? "api";
  if (role !== "api" && role !== "consumer" && role !== "worker") {
    throw new Error("Invalid configuration: APP_ROLE");
  }
  const sqsEndpoint = required("SQS_ENDPOINT");
  try {
    if (!["http:", "https:"].includes(new URL(sqsEndpoint).protocol)) throw new Error();
  } catch {
    throw new Error("Invalid configuration: SQS_ENDPOINT");
  }
  return Object.freeze({
    role: role as AppRole,
    port: port("PORT", "3000"),
    database: Object.freeze({
      host: required("DB_HOST"),
      port: port("DB_PORT", "5432"),
      dbName: required("DB_NAME"),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
    }),
    sqs: Object.freeze({
      endpoint: sqsEndpoint,
      region: required("AWS_REGION"),
      credentials: Object.freeze({
        accessKeyId: required("AWS_ACCESS_KEY_ID"),
        secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
      }),
    }),
  });
}

@Injectable()
export class Configuration {
  readonly values = parseConfiguration(process.env);
}
