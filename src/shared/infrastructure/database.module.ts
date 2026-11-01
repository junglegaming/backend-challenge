import { Global, Module } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { UnitOfWork } from "../application/unit-of-work";
import { Database } from "./database";
import { MikroOrmUnitOfWork } from "./unit-of-work";

@Global()
@Module({
  providers: [Configuration, Database, { provide: UnitOfWork, useClass: MikroOrmUnitOfWork }],
  exports: [Configuration, Database, UnitOfWork],
})
export class DatabaseModule {}
