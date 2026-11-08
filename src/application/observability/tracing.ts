import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';

export type TraceCarrier = { traceparent?: string; tracestate?: string };
const tracer = trace.getTracer('wagering');

export function captureTrace(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return { ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}) };
}

export function extractTrace(carrier: TraceCarrier | undefined): Context {
  return propagation.extract(ROOT_CONTEXT, carrier ?? {});
}

export function parseTraceCarrier(value: unknown): TraceCarrier | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.traceparent !== 'string') return undefined;
  return { traceparent: record.traceparent, ...(typeof record.tracestate === 'string' ? { tracestate: record.tracestate } : {}) };
}

export async function traced<T>(name: string, kind: SpanKind, work: (span: Span) => Promise<T>, parent = context.active()): Promise<T> {
  return tracer.startActiveSpan(name, { kind }, parent, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
