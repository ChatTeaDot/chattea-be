import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AuthModule } from "src/modules/auth/auth.module";
import { PhoneRepository } from "./phone.repository";
import { PhoneResolver } from "./phone.resolver";
import { PhoneService } from "./phone.service";
import { DevSmsSender, HttpSmsSender } from "./sms.sender";

@Module({
  imports: [AuthModule, JwtModule.register({ global: true })],
  providers: [
    PhoneResolver,
    PhoneService,
    PhoneRepository,
    {
      provide: "SmsSender",
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        if (configService.get<string>("SMS_PROVIDER_URL")) return new HttpSmsSender(configService);
        return new DevSmsSender();
      },
    },
  ],
})
export class PhoneModule {}
