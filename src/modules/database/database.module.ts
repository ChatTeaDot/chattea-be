import { Global, Module } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { DatabasePool } from "./database-pool";
import * as schema from "./schema";

export const DRIZZLE = Symbol("DRIZZLE");
export type Database = ReturnType<typeof drizzle<typeof schema>>;

@Global()
@Module({
  providers: [
    DatabasePool,
    {
      provide: DRIZZLE,
      inject: [DatabasePool],
      useFactory: (pool: DatabasePool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DatabasePool, DRIZZLE],
})
export class DatabaseModule {}
