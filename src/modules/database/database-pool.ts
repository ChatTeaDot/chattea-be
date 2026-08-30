import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { createPostgresSslOptions } from "src/common/config/postgres";

@Injectable()
export class DatabasePool extends Pool implements OnApplicationShutdown {
  constructor(configService: ConfigService) {
    super({
      host: configService.get<string>("POSTGRES_HOST"),
      port: configService.get<number>("POSTGRES_PORT"),
      user: configService.get<string>("POSTGRES_USERNAME"),
      password: configService.get<string>("POSTGRES_PASSWORD"),
      database: configService.get<string>("POSTGRES_DATABASE"),
      ssl: createPostgresSslOptions(
        configService.get<boolean | string>("POSTGRES_SSL"),
        configService.get<string>("POSTGRES_SSL_CA"),
      ),
    });
  }

  onApplicationShutdown = async (): Promise<void> => {
    await this.end();
  };
}
