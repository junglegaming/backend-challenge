import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { TransactionRunner } from "../database/transaction-runner";
import { SqsService } from "../messaging/sqs.service";
import { metricsRegistry } from "../observability/metrics";
import { Public } from "./provider-auth.guard";

interface ExpressLikeResponse {
  status: (code: number) => {
    json: (body: unknown) => void;
    send: (body: string) => void;
  };
  setHeader: (name: string, value: string) => void;
}

@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(TransactionRunner) private readonly txRunner: TransactionRunner,
    @Inject(SqsService) private readonly sqs: SqsService,
  ) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res() res: ExpressLikeResponse): Promise<void> {
    const checks: Record<"postgres" | "sqs", "up" | "down"> = {
      postgres: "down",
      sqs: "down",
    };

    await Promise.all([
      this.txRunner
        .ping()
        .then(() => {
          checks.postgres = "up";
        })
        .catch(() => undefined),
      this.sqs
        .ping()
        .then(() => {
          checks.sqs = "up";
        })
        .catch(() => undefined),
    ]);

    const healthy = checks.postgres === "up" && checks.sqs === "up";
    res
      .status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({ status: healthy ? "ok" : "degraded", checks });
  }

  @Get("metrics")
  async metricsEndpoint(@Res() res: ExpressLikeResponse): Promise<void> {
    res.setHeader("Content-Type", metricsRegistry.contentType);
    res.status(HttpStatus.OK).send(await metricsRegistry.metrics());
  }
}

