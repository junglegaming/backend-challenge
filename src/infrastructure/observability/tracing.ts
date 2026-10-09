/**
 * OpenTelemetry bootstrap. Loaded with `bun --preload` so the pg/http instrumentations hook their modules
 * before anything imports them. Disabled unless OTEL_ENABLED=true (zero overhead by default).
 *
 * Auto-instrumented: inbound/outbound HTTP, PostgreSQL queries (spike-verified on Bun).
 * Manually instrumented: SQS consume/publish and the outbox relay; W3C trace context travels in SQS
 * message attributes so a trace spans HTTP → DB → outbox → broker → consumer.
 */
import { context, propagation, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const enabled = process.env.OTEL_ENABLED === "true" || process.env.OTEL_ENABLED === "1";

if (enabled) {
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { PgInstrumentation },
    { HttpInstrumentation },
    { resourceFromAttributes },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/resources"),
  ]);
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "wagering-processor",
      "service.instance.id": process.env.INSTANCE_ID ?? `pid-${process.pid}`,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [
      new PgInstrumentation({ enhancedDatabaseReporting: false }), // never record query parameters (money)
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => /^\/(health|metrics)/.test(req.url ?? ""),
      }),
    ],
  });
  sdk.start();
  const stop = () => {
    void sdk.shutdown().catch(() => {});
  };
  process.once("beforeExit", stop);
}

const tracer = trace.getTracer("wagering-processor");

/** Runs `fn` inside a span; records errors; no-op tracer when OTel is disabled. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
  parent = context.active(),
): Promise<T> {
  const clean = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as Record<
    string,
    string | number | boolean
  >;
  return tracer.startActiveSpan(name, { kind, attributes: clean }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** W3C trace context → string map (for SQS message attributes). */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Restores a parent context from SQS message attributes. */
export function extractTraceContext(carrier: Record<string, string | undefined>) {
  return propagation.extract(context.active(), carrier);
}

export function currentTraceId(): string | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && ctx.traceId !== "00000000000000000000000000000000" ? ctx.traceId : undefined;
}

export { SpanKind };
