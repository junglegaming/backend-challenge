import "reflect-metadata";
import { afterAll, afterEach, expect, test } from "bun:test";
import { Controller, Get, Global, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Configuration } from "../../../src/config/config";
import { Scopes } from "../../../src/identity/authorization";
import { IdentityModule } from "../../../src/identity/identity.module";
import { JsonLogger } from "../../../src/observability/json-logger";
import { LogContext } from "../../../src/observability/log-context";
import { configureHttp } from "../../../src/shared/http/configure-http";
import type { HttpRequest } from "../../../src/shared/http/http-contract";
import { assertLedgerInvariant, testDatabase } from "../../support/database";
import { fakeJwks } from "../../support/fake-jwks";
import { errorBody } from "../../support/http";

const { database, values } = testDatabase();
afterEach(() => assertLedgerInvariant(database));
afterAll(() => database.onModuleDestroy());

@Controller("protected")
class IdentityProbeController {
  @Get()
  @Scopes("wagering")
  identity(@Req() request: HttpRequest) {
    return request.identity;
  }
}
@Global()
@Module({})
class ProbeConfigurationModule {}
@Module({})
class IdentityProbeModule {}

async function identityProbe(auth: { issuer: string; jwksUrl: string }) {
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: IdentityProbeModule,
      imports: [
        {
          module: ProbeConfigurationModule,
          providers: [
            { provide: Configuration, useValue: { values: { ...values, auth } } },
            LogContext,
            JsonLogger,
          ],
          exports: [Configuration, LogContext, JsonLogger],
        },
        IdentityModule,
      ],
      controllers: [IdentityProbeController],
    },
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  configureHttp(app);
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  return {
    close: () => app.close(),
    request: (token: string) =>
      fetch(`${url}/protected`, { headers: { Authorization: `Bearer ${token}` } }),
  };
}

test("real HTTP guard accepts a valid local JWKS token and rejects forged algorithms, claims and signatures", async () => {
  const jwks = await fakeJwks();
  const app = await identityProbe(jwks);
  try {
    const valid = await app.request(await jwks.token());
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      clientId: "provider-a",
      providerId: "provider-a",
      scopes: ["wagering"],
    });
    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      await jwks.token({ exp: now - 60 }),
      await jwks.token({ nbf: now + 60 }),
      await jwks.token({}, { wrongSignature: true }),
      await jwks.token({ iss: "https://wrong.example" }),
      await jwks.token({ aud: "another-api" }),
      await jwks.token({ exp: undefined }),
      await jwks.token({}, { kid: "unknown-key" }),
      jwks.unsigned(),
      await jwks.hmacWithPublicKey(),
      await jwks.token({ provider_id: ["provider-a"] }),
    ];
    for (const token of invalid) {
      const response = await app.request(token);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect((await errorBody(response)).error.code).toBe("UNAUTHENTICATED");
    }
  } finally {
    await app.close();
    await jwks.close();
  }
});

test("JWKS outages fail closed as 503 while a fresh cached signing key keeps working", async () => {
  const jwks = await fakeJwks();
  const cached = await identityProbe(jwks);
  const apps = [cached];
  try {
    const token = await jwks.token();
    expect((await cached.request(token)).status).toBe(200);
    const requests = jwks.requests;
    jwks.setMode("unavailable");
    expect((await cached.request(token)).status).toBe(200);
    expect(jwks.requests).toBe(requests);
    const uncached = await identityProbe(jwks);
    apps.push(uncached);
    const response = await uncached.request(token);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect((await errorBody(response)).error.code).toBe("TEMPORARILY_UNAVAILABLE");
    jwks.setMode("healthy");
    expect((await uncached.request(token)).status).toBe(200);
    const unknown = await identityProbe(jwks);
    apps.push(unknown);
    expect((await unknown.request(await jwks.token({}, { kid: "missing" }))).status).toBe(401);
    jwks.setMode("malformed");
    const malformed = await identityProbe(jwks);
    apps.push(malformed);
    expect((await malformed.request(token)).status).toBe(503);
    await jwks.close();
    const disconnected = await identityProbe(jwks);
    apps.push(disconnected);
    expect((await disconnected.request(token)).status).toBe(503);
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await jwks.close();
  }
});
