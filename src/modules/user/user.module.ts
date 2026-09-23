import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { JwtAccessTokenStrategy } from "src/strategys/access-token.strategy";
import { UserRepository } from "./user.repository";
import { UserResolver } from "./user.resolver";
import { UserService } from "./user.service";

@Module({
  imports: [JwtModule.register({ global: true })],
  providers: [UserResolver, UserService, UserRepository, JwtAccessTokenGuard, JwtAccessTokenStrategy],
  exports: [UserService, UserRepository],
})
export class UserModule {}
