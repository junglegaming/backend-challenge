export type LocalClient = "provider-a" | "provider-b" | "platform-operator";
const tokens = new Map<LocalClient, Promise<{ value: string; expiresAt: number }>>();

export async function accessToken(client: LocalClient): Promise<string> {
  let token = tokens.get(client);
  if (token && (await token).expiresAt <= Date.now()) token = undefined;
  if (!token) {
    token = (async () => {
      const secret =
        client === "provider-a"
          ? (process.env.PROVIDER_A_SECRET ?? "local-dev-only-provider-a")
          : client === "provider-b"
            ? (process.env.PROVIDER_B_SECRET ?? "local-dev-only-provider-b")
            : (process.env.OPERATOR_SECRET ?? "local-dev-only-platform-operator");
      const response = await fetch(
        "http://127.0.0.1:18080/realms/wagering/protocol/openid-connect/token",
        {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: client,
            client_secret: secret,
          }),
        },
      );
      if (!response.ok) throw new Error(`Local identity provider returned ${response.status}`);
      const body = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token || !body.expires_in || body.expires_in <= 10)
        throw new Error("Local identity provider returned no usable access token");
      return { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 10) * 1000 };
    })();
    tokens.set(client, token);
  }
  return (await token).value;
}
