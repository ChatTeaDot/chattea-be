import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy, StrategyOptions } from "passport-jwt";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "src/modules/auth/auth.error";
import { AuthService } from "src/modules/auth/auth.service";
import { RefreshAuthRequest } from "src/modules/auth/auth.types";
import { AUTH_TOKEN_AUDIENCE, AUTH_TOKEN_ISSUER, isRefreshTokenClaims } from "src/modules/auth/token-claims";

export const refreshTokenFromRequest = (request: Pick<Request, "cookies" | "headers">): string | null => {
  const authorization = request.headers?.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1];
  }
  return request.cookies?.refresh_token ?? null;
};

@Injectable()
export class JwtRefreshTokenStrategy extends PassportStrategy(Strategy, "refresh_token") {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([(request: Request) => refreshTokenFromRequest(request)]),
      secretOrKey: configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
      audience: AUTH_TOKEN_AUDIENCE,
      issuer: AUTH_TOKEN_ISSUER,
      ignoreExpiration: false,
      passReqToCallback: true,
    } satisfies StrategyOptions);
  }

  async validate(req: RefreshAuthRequest, payload: unknown) {
    const refreshToken = refreshTokenFromRequest(req);

    if (!refreshToken || !isRefreshTokenClaims(payload)) {
      throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenUndefined);
    }

    const validatedRefreshToken = await this.authService.validateUserRefreshToken(
      payload.userId,
      payload.deviceId,
      refreshToken,
    );

    if (!validatedRefreshToken) {
      throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenWrong);
    }
    req.validatedRefreshToken = validatedRefreshToken;
    req.user = payload;

    return payload;
  }
}
