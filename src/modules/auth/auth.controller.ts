import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { KakaoGuard } from "src/guards/kakao.guard";
import { AuthService } from "./auth.service";
import { authCookieOptions } from "./cookie-options";
import { KakaoRequest } from "./auth.types";

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(KakaoGuard)
  @Get("kakao")
  kakaoLogin() {}

  @UseGuards(KakaoGuard)
  @Get("kakao/callback")
  async kakaoCallback(@Req() req: KakaoRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.loginWithKakao(req.user);
    res.clearCookie("kakao_oauth_state", authCookieOptions);
    res.cookie("kakao_phone_verification_token", result.kakaoPhoneVerificationToken, authCookieOptions);
    return { kakaoPhoneVerificationToken: result.kakaoPhoneVerificationToken };
  }
}
