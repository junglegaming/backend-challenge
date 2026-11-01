import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Dependencies } from "./dependencies";

export function configureShutdownReadiness(
  adapter: FastifyAdapter,
  dependencies: Dependencies,
): void {
  const beforeClose = adapter.beforeClose.bind(adapter);
  adapter.beforeClose = () => {
    dependencies.beginShutdown();
    beforeClose();
  };
}
