import { MikroORM, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { databaseOptions } from "../../../mikro-orm.config";
import { Configuration } from "../../config/config";

@Injectable()
export class Database implements OnModuleDestroy {
  readonly orm: ReturnType<typeof MikroORM.init<PostgreSqlDriver>>;
  constructor(configuration: Configuration) {
    this.orm = MikroORM.init(databaseOptions(configuration.values.database));
  }
  async onModuleDestroy(): Promise<void> {
    await (await this.orm).close(true);
  }
}
