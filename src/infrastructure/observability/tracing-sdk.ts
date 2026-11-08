import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export function startTracing(): NodeSDK | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint || process.env.OTEL_SDK_DISABLED === 'true') return undefined;
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'wagering-processor',
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    contextManager: new AsyncLocalStorageContextManager(),
    textMapPropagator: new W3CTraceContextPropagator(),
  });
  sdk.start();
  return sdk;
}
