import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { KakaoGuard } from "src/guards/kakao.guard";
import { AuthService } from "./auth.service";
import { authCookieOptions } from "./cookie-options";
import { KakaoRequest } from "./auth.types";

@Controller("api/auth")
export class AuthController {
  /**
   * AuthController에서 사용할 AuthService 의존성을 주입한다.
   *
   * @param authService 인증 서비스
   */
  constructor(private readonly authService: AuthService) {}

  /**
   * 카카오 OAuth 로그인 시작 엔드포인트다.
   *
   * @returns void
   */
  @UseGuards(KakaoGuard)
  @Get("kakao")
  kakaoLogin() {}

  /**
   * 카카오 OAuth 콜백을 처리하고 임시 가입 토큰 쿠키를 설정한다.
   *
   * @param req 카카오 인증 요청 객체
   * @param res Express 응답 객체
   * @param state OAuth state
   * @returns 카카오 임시 가입 토큰
   */
  @UseGuards(KakaoGuard)
  @Get("kakao/callback")
  async kakaoCallback(@Req() req: KakaoRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.loginWithKakao(req.user);
    res.clearCookie("kakao_oauth_state", authCookieOptions);
    res.cookie("kakao_phone_verification_token", result.kakaoPhoneVerificationToken, authCookieOptions);
    return { kakaoPhoneVerificationToken: result.kakaoPhoneVerificationToken };
  }
}
