import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "../../identity/authorization";
import { Dependencies } from "./dependencies";

@Controller("health")
@Public()
export class HealthController {
  constructor(private readonly dependencies: Dependencies) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    if (!(await this.dependencies.check())) throw new ServiceUnavailableException();
    return { status: "ready" };
  }
}
