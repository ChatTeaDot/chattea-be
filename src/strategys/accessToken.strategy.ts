import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy, StrategyOptions } from "passport-jwt";
import { AuthRequest } from "src/modules/auth/auth.types";
import { AUTH_TOKEN_AUDIENCE, AUTH_TOKEN_ISSUER, isAccessTokenClaims } from "src/modules/auth/token-claims";
import { UserRepository } from "src/modules/user/user.repository";

@Injectable()
export class JwtAccessTokenStrategy extends PassportStrategy(Strategy, "access_token") {
  constructor(
    configService: ConfigService,
    private readonly userRepository: UserRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (request: Request) => request.cookies?.access_token ?? null,
      ]),
      secretOrKey: configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
      audience: AUTH_TOKEN_AUDIENCE,
      issuer: AUTH_TOKEN_ISSUER,
      ignoreExpiration: false,
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  async validate(req: AuthRequest, payload: unknown) {
    if (!isAccessTokenClaims(payload)) throw new UnauthorizedException();
    const user = await this.userRepository.findUser(payload.userId);
    if (!user || user.hiddenAt || user.deletedAt) {
      throw new UnauthorizedException();
    }
    req.user = payload;
    return payload;
  }
}
