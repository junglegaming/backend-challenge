import { describe, expect, test } from "bun:test";
import {
  InvalidTransactionInputError,
  InvalidTransactionStateError,
} from "../../src/shared/domain/domain-error";
import { FailureCode as Code, FailureCode } from "../../src/wagering/domain/failure-code";
import { settle } from "../../src/wagering/domain/settlement";
import {
  CreateWagerTransactionProps,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from "../../src/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/wagering/domain/wallet-ledger-entry";
import { assertUnitLedgerInvariant, money, now, open, transaction } from "./domain-fixtures";

function reference(
  overrides: Partial<CreateWagerTransactionProps> = {},
  status = Status.Processed,
) {
  const ref = transaction({ externalTransactionId: "reference", ...overrides });
  if (status === Status.Processed) ref.markProcessed(undefined, now, money("100.00"));
  else if (status === Status.PendingReference) ref.markPendingReference(now, money("100.00"));
  else if (status === Status.Rejected) ref.reject(Code.InsufficientFunds, now, money("100.00"));
  else if (status === Status.Failed) ref.fail(Code.PermanentProcessingError, now, money("100.00"));
  return ref;
}

interface Scenario {
  name: string;
  transaction?: Partial<CreateWagerTransactionProps>;
  balance?: string;
  noWallet?: boolean;
  reference?: () => WagerTransaction;
  reversed?: boolean;
  deadline?: boolean;
  expected: FailureCode | "pending" | "processed";
  expectedBalance?: string;
}

const scenarios: Scenario[] = [
  {
    name: "1 missing wallet wins over every later rule",
    noWallet: true,
    transaction: { playerId: "other", money: money("0.00", "USD") },
    expected: Code.WalletNotFound,
  },
  {
    name: "2 player mismatch before currency and zero",
    transaction: { playerId: "other", money: money("0.00", "USD") },
    expected: Code.PlayerWalletMismatch,
  },
  {
    name: "3 currency mismatch before zero",
    transaction: { money: money("0.00", "USD") },
    expected: Code.CurrencyMismatch,
  },
  ...[Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback].map(
    (kind): Scenario => ({
      name: `4 zero ${kind}`,
      transaction: {
        kind,
        money: money("0.00"),
        ...([Kind.Refund, Kind.Rollback].includes(kind)
          ? { referenceExternalTransactionId: "reference" }
          : {}),
      },
      expected: Code.AmountNotPositive,
    }),
  ),
  {
    name: "5 missing reference waits",
    transaction: { kind: Kind.Refund, referenceExternalTransactionId: "reference" },
    expected: "pending",
  },
  {
    name: "5 missing reference expires",
    transaction: { kind: Kind.Refund, referenceExternalTransactionId: "reference" },
    deadline: true,
    expected: Code.ReferenceNotFound,
  },
  ...[Kind.Refund, Kind.Win, Kind.Loss].map(
    (kind): Scenario => ({
      name: `6 ${kind} requires BET even while reference pending`,
      transaction: { kind, referenceExternalTransactionId: "reference" },
      reference: () =>
        reference(
          { kind: Kind.Refund, referenceExternalTransactionId: "base" },
          Status.PendingReference,
        ),
      expected: Code.ReferenceKindNotAllowed,
    }),
  ),
  {
    name: "6 ROLLBACK cannot reference LOSS",
    transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
    reference: () => reference({ kind: Kind.Loss }),
    expected: Code.ReferenceKindNotAllowed,
  },
  ...[
    { providerId: "provider-b" },
    { playerId: "other" },
    { walletId: crypto.randomUUID() },
    { money: money("11.00", "USD") },
    { roundId: "other" },
  ].map(
    (override, index): Scenario => ({
      name: `7 scope mismatch ${index} wins over amount`,
      transaction: { kind: Kind.Refund, referenceExternalTransactionId: "reference" },
      reference: () => reference(override),
      expected: Code.ReferenceScopeMismatch,
    }),
  ),
  {
    name: "8 amount mismatch before reference readiness",
    transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
    reference: () =>
      reference(
        { kind: Kind.Refund, referenceExternalTransactionId: "base", money: money("11.00") },
        Status.PendingReference,
      ),
    expected: Code.ReferenceAmountMismatch,
  },
  {
    name: "9 pending reference waits",
    transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
    reference: () =>
      reference(
        { kind: Kind.Refund, referenceExternalTransactionId: "base" },
        Status.PendingReference,
      ),
    expected: "pending",
  },
  {
    name: "9 pending reference expires distinctly",
    transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
    reference: () =>
      reference(
        { kind: Kind.Refund, referenceExternalTransactionId: "base" },
        Status.PendingReference,
      ),
    deadline: true,
    expected: Code.ReferenceNotProcessed,
  },
  ...[Status.Rejected, Status.Failed].map(
    (status): Scenario => ({
      name: `10 reference ${status} is final`,
      transaction: { kind: Kind.Refund, referenceExternalTransactionId: "reference" },
      reference: () => reference({}, status),
      expected: Code.ReferenceNotProcessed,
    }),
  ),
  ...[Kind.Refund, Kind.Rollback].map(
    (kind): Scenario => ({
      name: `11 ${kind} shares the direct-reversal limit`,
      transaction: { kind, referenceExternalTransactionId: "reference" },
      reference,
      reversed: true,
      expected: Code.ReferenceAlreadyReversed,
    }),
  ),
  {
    name: "12 zero LOSS is informative",
    transaction: { kind: Kind.Loss, money: money("0.00") },
    expected: "processed",
    expectedBalance: "100.00",
  },
  {
    name: "12 positive LOSS is informative",
    transaction: { kind: Kind.Loss },
    expected: "processed",
    expectedBalance: "100.00",
  },
  {
    name: "12 LOSS may refer to reversed BET",
    transaction: { kind: Kind.Loss, referenceExternalTransactionId: "reference" },
    reference,
    reversed: true,
    expected: "processed",
    expectedBalance: "100.00",
  },
  { name: "13 insufficient BET", balance: "5.00", expected: Code.InsufficientFunds },
  {
    name: "13 spent WIN rollback is distinct",
    balance: "5.00",
    transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
    reference: () => reference({ kind: Kind.Win }),
    expected: Code.ReversalInsufficientFunds,
  },
  { name: "14 BET debits", expected: "processed", expectedBalance: "90.00" },
  {
    name: "14 WIN without reference credits",
    transaction: { kind: Kind.Win },
    expected: "processed",
    expectedBalance: "110.00",
  },
  {
    name: "14 WIN may reference reversed BET",
    transaction: { kind: Kind.Win, referenceExternalTransactionId: "reference" },
    reference,
    reversed: true,
    expected: "processed",
    expectedBalance: "110.00",
  },
  {
    name: "14 REFUND credits",
    transaction: { kind: Kind.Refund, referenceExternalTransactionId: "reference" },
    reference,
    expected: "processed",
    expectedBalance: "110.00",
  },
  {
    name: "14 ROLLBACK of BET credits",
    transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
    reference,
    expected: "processed",
    expectedBalance: "110.00",
  },
  ...[Kind.Win, Kind.Refund].map(
    (kind): Scenario => ({
      name: `14 ROLLBACK of ${kind} debits`,
      transaction: { kind: Kind.Rollback, referenceExternalTransactionId: "reference" },
      reference: () =>
        reference({
          kind,
          ...(kind === Kind.Refund ? { referenceExternalTransactionId: "base" } : {}),
        }),
      expected: "processed",
      expectedBalance: "90.00",
    }),
  ),
];

describe("ordered settlement table", () => {
  test.each(scenarios)("$name", (scenario) => {
    const { wallet, entries } = open(scenario.balance);
    const tx = transaction(scenario.transaction);
    const ref = scenario.reference?.() ?? null;
    const result = settle({
      transaction: tx,
      wallet: scenario.noWallet ? null : wallet,
      reference: ref,
      referenceHasProcessedReversal: scenario.reversed ?? false,
      deadlineReached: scenario.deadline ?? false,
      now,
    });
    if (scenario.expected === "processed") {
      expect(result.type).toBe("processed");
      expect(tx.status).toBe(Status.Processed);
      expect(wallet.balance.toString()).toBe(
        scenario.expectedBalance ?? scenario.balance ?? "100.00",
      );
      if (result.type === "processed" && result.ledgerEntry) entries.push(result.ledgerEntry);
      expect(entries.length).toBe(tx.kind === Kind.Loss ? 1 : 2);
      expect(wallet.version).toBe(tx.kind === Kind.Loss ? 1 : 2);
    } else if (scenario.expected === "pending") {
      expect(result.type).toBe("pending");
      expect(tx.status).toBe(Status.PendingReference);
    } else {
      expect(result).toEqual({ type: "rejected", code: scenario.expected });
      expect(tx.failureCode).toBe(scenario.expected);
      expect(tx.referenceTransactionId).toBe(ref?.id);
    }
    expect(tx.observedBalance?.toString() ?? null).toBe(
      scenario.noWallet ? null : wallet.balance.toString(),
    );
    assertUnitLedgerInvariant(wallet, entries);
  });
});

test("equivalent UUID letter cases preserve the reference wallet scope", () => {
  for (const uppercaseBet of [false, true]) {
    const { wallet, entries } = open();
    const bet = transaction({ walletId: uppercaseBet ? wallet.id.toUpperCase() : wallet.id });
    const refund = transaction({
      kind: Kind.Refund,
      walletId: uppercaseBet ? wallet.id : wallet.id.toUpperCase(),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    for (const [tx, ref] of [
      [bet, null],
      [refund, bet],
    ] as const) {
      const outcome = settle({
        transaction: tx,
        wallet,
        reference: ref,
        referenceHasProcessedReversal: false,
        deadlineReached: false,
        now,
      });
      expect(outcome.type).toBe("processed");
      if (outcome.type === "processed" && outcome.ledgerEntry) entries.push(outcome.ledgerEntry);
    }
    expect(wallet.balance.toString()).toBe("100.00");
    expect(entries).toHaveLength(3);
    assertUnitLedgerInvariant(wallet, entries);
  }
});

test("pending retries keep the first deadline and grow to the configured cap", () => {
  const { wallet, entries } = open();
  const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "missing" });
  tx.markPendingReference(now, wallet.balance, 20_000);
  const deadline = tx.referenceDeadlineAt?.toISOString();
  expect(tx.nextAttemptAt?.getTime()).toBe(now.getTime() + 5000);
  tx.markPendingReference(new Date(now.getTime() + 1000), wallet.balance, 1_000_000);
  expect(tx.referenceDeadlineAt?.toISOString()).toBe(deadline);
  expect(tx.nextAttemptAt?.getTime()).toBe(now.getTime() + 11_000);
  for (let count = 0; count < 20; count++) tx.scheduleReferenceRetry(now);
  expect(tx.nextAttemptAt?.getTime()).toBe(now.getTime() + 300_000);
  assertUnitLedgerInvariant(wallet, entries);
});

test.each([Status.Processed, Status.Rejected, Status.Failed])(
  "every transition from %s throws without wallet effects",
  (status) => {
    const { wallet, entries } = open();
    const tx = reference({}, status);
    const transitions = [
      () => tx.markProcessed(undefined, now, wallet.balance),
      () => tx.markPendingReference(now, wallet.balance),
      () => tx.scheduleReferenceRetry(now),
      () => tx.reject(Code.InsufficientFunds, now, wallet.balance),
      () => tx.fail(Code.PermanentProcessingError, now, wallet.balance),
      () =>
        settle({
          transaction: tx,
          wallet,
          reference: null,
          referenceHasProcessedReversal: false,
          deadlineReached: false,
          now,
        }),
    ];
    for (const transition of transitions) expect(transition).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(status);
    assertUnitLedgerInvariant(wallet, entries);
  },
);

test("payload matching and strict domain input checks do not normalize identifiers", () => {
  const tx = transaction();
  expect(tx.matchesPayload("a".repeat(64))).toBe(true);
  expect(tx.matchesPayload("b".repeat(64))).toBe(false);
  const invalid: Partial<CreateWagerTransactionProps>[] = [
    { kind: Kind.Refund },
    { kind: Kind.Rollback },
    { referenceExternalTransactionId: "reference" },
    { externalTransactionId: "self", referenceExternalTransactionId: "self", kind: Kind.Win },
    { kind: Kind.Opening, providerId: "internal" },
    { providerId: "internal" },
    { providerId: "Provider-A" },
    { providerId: "a" },
    { providerId: undefined },
    { playerId: "with spaces" },
    { gameId: "bad\n" },
    { walletId: "not-uuid" },
    { idempotencyKey: undefined },
    { money: money("1.00").negate() },
  ];
  for (const override of invalid)
    expect(() => transaction(override)).toThrow(InvalidTransactionInputError);
});

test("direction is explicit, OPENING is internal, and rehydrate does not rerun transitions", () => {
  const tx = WagerTransaction.create(
    {
      id: crypto.randomUUID(),
      providerId: "internal",
      externalTransactionId: "opening",
      idempotencyKey: "opening",
      payloadHash: "a".repeat(64),
      walletId: crypto.randomUUID(),
      playerId: "player",
      roundId: "opening",
      gameId: "opening",
      kind: Kind.Opening,
      money: money("10.00"),
      createdAt: now,
    },
    "internal",
  );
  expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  const restored = WagerTransaction.rehydrate({
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    createdAt: now,
    status: Status.Processed,
    observedBalance: money("10.00"),
    referenceAttempts: 0,
  });
  expect(restored.status).toBe(Status.Processed);
  expect(() => restored.markProcessed(undefined, now, money("10.00"))).toThrow(
    InvalidTransactionStateError,
  );
  expect(() => transaction({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
    InvalidTransactionInputError,
  );
});
