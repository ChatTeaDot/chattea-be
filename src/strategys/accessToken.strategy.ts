import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy, StrategyOptions } from "passport-jwt";
import { AuthRequest, JwtPayload } from "src/modules/auth/auth.types";
import { UserRepository } from "src/modules/user/user.repository";

@Injectable()
export class JwtAccessTokenStrategy extends PassportStrategy(Strategy, "access_token") {
  constructor(
    private readonly configService: ConfigService,
    private readonly userRepository: UserRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (request: Request) => request.cookies?.access_token ?? null,
      ]),
      secretOrKey: configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
      ignoreExpiration: false,
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  async validate(req: AuthRequest, payload: JwtPayload) {
    const user = await this.userRepository.findUser(payload.userId);
    if (!user || user.hiddenAt || user.deletedAt) {
      throw new UnauthorizedException();
    }
    req.user = payload;
    return payload;
  }
}
