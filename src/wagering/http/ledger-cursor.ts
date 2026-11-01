import { ApiError } from "../../shared/http/http-contract";

export function ledgerCursor(walletId: string, walletVersion: number): string {
  return Buffer.from(JSON.stringify({ walletId: walletId.toLowerCase(), walletVersion })).toString(
    "base64url",
  );
}

export function parseLedgerQuery(walletId: string, query: Record<string, unknown>) {
  if (Object.keys(query).some((key) => key !== "cursor" && key !== "limit"))
    throw new ApiError(400, "VALIDATION_FAILED", "Unknown query field");
  let limit = 50;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^[1-9][0-9]*$/.test(query.limit))
      throw new ApiError(400, "VALIDATION_FAILED", "Invalid page limit");
    limit = Math.min(Number(query.limit), 100);
  }
  let afterVersion = 0;
  if (query.cursor !== undefined && query.cursor !== "") {
    try {
      if (
        typeof query.cursor !== "string" ||
        query.cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(query.cursor)
      )
        throw new Error();
      const decoded: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!decoded || typeof decoded !== "object") throw new Error();
      const value = decoded as Record<string, unknown>;
      if (
        Object.keys(value).length !== 2 ||
        value.walletId !== walletId.toLowerCase() ||
        typeof value.walletVersion !== "number" ||
        !Number.isSafeInteger(value.walletVersion) ||
        value.walletVersion < 1 ||
        ledgerCursor(walletId, value.walletVersion) !== query.cursor
      )
        throw new Error();
      afterVersion = value.walletVersion;
    } catch {
      throw new ApiError(400, "INVALID_CURSOR", "Invalid ledger cursor");
    }
  }
  return { limit, afterVersion };
}
