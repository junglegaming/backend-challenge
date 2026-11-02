import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  SendMessageBatchCommandInput,
  SendMessageBatchCommandOutput,
} from "@aws-sdk/client-sqs";
import { type LoadFixtures, loadCommand } from "../../load/model";
import { createBacklogSender, produceBacklog } from "../../load/sqs-producer";
import { SqsTransport } from "../../src/messaging/infrastructure/sqs-transport";
import { assertLedgerInvariant } from "../support/database";
import { openHttpWallet } from "../support/http";
import { pollUntil } from "../support/stack";
import { wageringHarness } from "../support/wagering";

test("remote backlog survives injected throttles and partial confirmation through real SQS and SQL", async () => {
  const h = wageringHarness();
  const transport = new SqsTransport({ values: h.values });
  const sent: SendMessageBatchCommandInput[] = [];
  // Inject only the failure boundary; every successful entry goes through the real broker.
  transport.client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName !== "SendMessageBatchCommand") return next(args);
      const input = args.input as SendMessageBatchCommandInput;
      sent.push(structuredClone(input));
      if (sent.length === 1)
        throw Object.assign(new Error("Deliberate producer throttle"), {
          name: "RequestThrottled",
          $metadata: { httpStatusCode: 400 },
        });
      if (sent.length === 2) {
        const result = await next({
          ...args,
          input: { ...input, Entries: input.Entries?.slice(0, 1) },
        });
        const output = result.output as SendMessageBatchCommandOutput;
        return {
          ...result,
          output: {
            ...output,
            Failed: input.Entries?.slice(1).map(({ Id }) => ({
              Id,
              Code: "RequestThrottled",
              SenderFault: false,
            })),
          },
        };
      }
      return next(args);
    },
    { name: "loadProducerThrottleInjection", step: "initialize" },
  );
  try {
    const first = await openHttpWallet();
    const second = await openHttpWallet();
    const fixtures: LoadFixtures = {
      runId: randomUUID(),
      profile: "quick",
      hot: first,
      distributed: [first, second],
      replays: [],
    };
    const abort = new AbortController();
    const sender = createBacklogSender(transport, abort.signal);
    await produceBacklog(transport, fixtures, 2, abort.signal, sender);
    expect(sent).toHaveLength(3);
    // Compare booleans to keep real financial envelopes out of assertion diagnostics.
    expect(JSON.stringify(sent[1]?.Entries) === JSON.stringify(sent[0]?.Entries)).toBe(true);
    expect(JSON.stringify(sent[2]?.Entries) === JSON.stringify(sent[0]?.Entries?.slice(1))).toBe(
      true,
    );
    expect(sender.stats).toMatchObject({ attempts: 3, retries: 2, confirmed: 2, failedBatches: 0 });
    for (const [index, wallet] of fixtures.distributed.entries()) {
      const command = loadCommand(fixtures, "sqs_backlog", "distributed", index);
      await pollUntil(
        "retried producer transaction committed",
        async () =>
          (await h.queries.providerTransaction("provider-a", command.key))?.status === "PROCESSED",
      );
      expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe(
        index === 0 ? "99.00" : "101.00",
      );
      expect(await h.queries.ledgerPage(wallet.id, 0, 100)).toHaveLength(2);
    }
  } finally {
    transport.close();
    try {
      await assertLedgerInvariant(h.database);
    } finally {
      await h.database.onModuleDestroy();
    }
  }
}, 60_000);
