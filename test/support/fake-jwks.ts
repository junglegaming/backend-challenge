import { exportJWK, exportSPKI, generateKeyPair, JWTPayload, SignJWT } from "jose";

export async function fakeJwks() {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  let mode: "healthy" | "unavailable" | "malformed" = "healthy";
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      if (mode === "unavailable") return new Response("unavailable", { status: 503 });
      if (mode === "malformed") return new Response("{");
      return Response.json({ keys: [jwk] });
    },
  });
  const issuer = "https://test-issuer.example/realm";
  const claims = (overrides: JWTPayload = {}) => ({
    iss: issuer,
    aud: "wagering-api",
    azp: "provider-a",
    provider_id: "provider-a",
    scope: "wagering",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
  return {
    issuer,
    jwksUrl: `${server.url}jwks`,
    setMode(value: typeof mode) {
      mode = value;
    },
    get requests() {
      return requests;
    },
    async token(
      overrides: JWTPayload = {},
      options: { wrongSignature?: boolean; kid?: string } = {},
    ) {
      return new SignJWT(claims(overrides))
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "test-key" })
        .sign(options.wrongSignature ? other.privateKey : keys.privateKey);
    },
    unsigned() {
      return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`;
    },
    async hmacWithPublicKey() {
      return new SignJWT(claims())
        .setProtectedHeader({ alg: "HS256", kid: "test-key" })
        .sign(new TextEncoder().encode(await exportSPKI(keys.publicKey)));
    },
    async close() {
      await server.stop(true);
    },
  };
}
