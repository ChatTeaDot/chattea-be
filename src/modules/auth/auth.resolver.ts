import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { JwtRefreshTokenGuard } from "src/guards/refreshToken.guard";
import { authCookieOptions } from "./cookie-options";
import { AuthService } from "./auth.service";
import { deviceIdFromRequest } from "./device-id";
import { KakaoLoginPayload, RefreshAuthRequest, TokenPayload } from "./auth.types";

const setTokenCookies = (res: Response, tokenData: TokenPayload) => {
  res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`);
  res.cookie("access_token", tokenData.accessToken, authCookieOptions);
  res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions);
};

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => KakaoLoginPayload)
  async loginWithKakao(
    @Args("accessToken") accessToken: string,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const result = await this.authService.loginWithKakaoAccessToken(accessToken, deviceIdFromRequest(req));
    if (!result.requiresPhone) setTokenCookies(res, result.session);
    return result;
  }

  @UseGuards(JwtRefreshTokenGuard)
  @Mutation(() => TokenPayload)
  async refresh(@Context("req") req: RefreshAuthRequest, @Context("res") res: Response) {
    const tokenData = await this.authService.refresh(req.validatedRefreshToken);
    setTokenCookies(res, tokenData);
    return tokenData;
  }

  @UseGuards(JwtRefreshTokenGuard)
  @Mutation(() => Boolean)
  async logout(@Context("req") req: RefreshAuthRequest, @Context("res") res: Response) {
    await this.authService.logout(req.user.userId, req.user.deviceId);
    res.clearCookie("access_token", authCookieOptions);
    res.clearCookie("refresh_token", authCookieOptions);
    return true;
  }
}
