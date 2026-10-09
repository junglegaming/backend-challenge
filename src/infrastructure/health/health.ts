import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../../modules/auth/provider-auth";
import type { AppLogger } from "../../shared/application/observability";
import { PromMetrics } from "../observability/metrics";

export interface DependencyCheck {
  name: string;
  check(timeoutMs: number): Promise<void>;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  /** `error` only ever carries a fixed, non-sensitive reason ("unavailable", "draining"). */
  checks: Record<string, { ok: boolean; latencyMs: number; error?: "unavailable" | "draining" }>;
}

/**
 * Readiness = PostgreSQL and SQS reachable and the process is not draining. Results are cached briefly so
 * aggressive probes cannot turn into load on the dependencies.
 *
 * The endpoint is public (the challenge requires it unauthenticated, and it is reachable through the edge), so the
 * body never carries raw driver errors — they can name internal hosts, ports or users. The real error goes to the
 * log, where operators look anyway.
 */
export class ReadinessService {
  private draining = false;
  private cached: { at: number; report: ReadinessReport } | undefined;

  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly logger?: AppLogger,
    private readonly options = { timeoutMs: 1500, cacheMs: 2000 },
  ) {}

  /** Called first on SIGTERM so load balancers stop routing before in-flight work drains. */
  markDraining(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  async report(): Promise<ReadinessReport> {
    if (this.draining)
      return { status: "not_ready", checks: { shutdown: { ok: false, latencyMs: 0, error: "draining" } } };
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.options.cacheMs) return this.cached.report;

    const entries = await Promise.all(
      this.checks.map(async (c) => {
        const started = performance.now();
        try {
          await c.check(this.options.timeoutMs);
          return [c.name, { ok: true, latencyMs: Math.round(performance.now() - started) }] as const;
        } catch (error) {
          this.logger?.warn({ err: error, dependency: c.name }, "readiness check failed");
          return [
            c.name,
            { ok: false, latencyMs: Math.round(performance.now() - started), error: "unavailable" as const },
          ] as const;
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const report: ReadinessReport = {
      status: entries.every(([, r]) => r.ok) ? "ready" : "not_ready",
      checks,
    };
    this.cached = { at: now, report };
    return report;
  }
}

@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly metrics: PromMetrics,
  ) {}

  /** Liveness: the process and its event loop respond. No dependency checks (a DB outage must not restart pods). */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.readiness.report();
    res.status(report.status === "ready" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  @Get("metrics")
  async scrape(@Res() res: Response) {
    res.setHeader("Content-Type", this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
