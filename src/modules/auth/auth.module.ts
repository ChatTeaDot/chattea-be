import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { JwtRefreshTokenGuard } from "src/guards/refresh-token.guard";
import { KakaoGuard } from "src/guards/kakao.guard";
import { KakaoStrategy } from "src/strategys/kakao.strategy";
import { JwtRefreshTokenStrategy } from "src/strategys/refresh-token.strategy";
import { UserModule } from "src/modules/user/user.module";
import { AuthController } from "./auth.controller";
import { AuthRepository } from "./auth.repository";
import { AuthResolver } from "./auth.resolver";
import { AuthService } from "./auth.service";

@Module({
  imports: [JwtModule.register({ global: true }), UserModule],
  controllers: [AuthController],
  providers: [
    AuthResolver,
    AuthService,
    AuthRepository,
    JwtRefreshTokenGuard,
    JwtRefreshTokenStrategy,
    KakaoGuard,
    KakaoStrategy,
  ],
  exports: [AuthService],
})
export class AuthModule {}
