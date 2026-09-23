import { Logger, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "src/common/config/environment";
import { DatabaseModule } from "src/modules/database/database.module";
import { DatabasePool } from "src/modules/database/database-pool";
import { NotificationModule } from "src/modules/notification/notification.module";
import { NotificationService } from "src/modules/notification/notification.service";
import { UploadModule } from "src/modules/upload/upload.module";
import { UploadService } from "src/modules/upload/upload.service";
import { UserModule } from "src/modules/user/user.module";
import { UserService } from "src/modules/user/user.service";
import { MaintenanceLockService } from "./maintenance-lock.service";
import { FileMaintenanceHeartbeat, MaintenanceRunner, MaintenanceServices } from "./maintenance.runner";

const createMaintenanceLock = (pool: DatabasePool): MaintenanceLockService => new MaintenanceLockService(pool);

const createMaintenanceRunner = (
  userService: UserService,
  notificationService: NotificationService,
  uploadService: UploadService,
  lock: MaintenanceLockService,
): MaintenanceRunner => {
  const services: MaintenanceServices = { userService, notificationService, uploadService };
  const logger = new Logger("Maintenance");
  return new MaintenanceRunner({
    services,
    lock,
    heartbeat: new FileMaintenanceHeartbeat("/tmp/chattea-maintenance-heartbeat"),
    logger,
  });
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validate: validateEnvironment,
    }),
    DatabaseModule,
    UserModule,
    NotificationModule,
    UploadModule,
  ],
  providers: [
    { provide: MaintenanceLockService, inject: [DatabasePool], useFactory: createMaintenanceLock },
    {
      provide: MaintenanceRunner,
      inject: [UserService, NotificationService, UploadService, MaintenanceLockService],
      useFactory: createMaintenanceRunner,
    },
  ],
})
export class MaintenanceModule {}
