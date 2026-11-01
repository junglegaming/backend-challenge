import { Injectable } from "@nestjs/common";
import pino from "pino";
import { Counter, Registry } from "prom-client";

@Injectable()
export class WageringTelemetry {
  readonly registry = new Registry();
  readonly divergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Wallet reconciliation divergences",
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Database lock conflicts",
    registers: [this.registry],
  });
  private readonly logger = pino();

  reconciliationDiverged(walletId: string): void {
    this.divergences.inc();
    this.logger.error({ event: "reconciliation_divergence", walletId });
  }
  databaseError(error: unknown): void {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "55P03" || error.code === "40P01")
    )
      this.lockConflicts.inc();
  }
}
