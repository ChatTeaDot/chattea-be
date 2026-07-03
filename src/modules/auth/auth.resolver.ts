import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { JwtRefreshTokenGuard } from "src/guards/refreshToken.guard";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { authCookieOptions } from "./cookie-options";
import { AuthService } from "./auth.service";
import { AuthErrorMessage } from "./auth.error";
import { RefreshAuthRequest, SignedPayload, SigninAuthInput, SignupAuthInput, TokenPayload } from "./auth.types";

/**
 * access/refresh token을 응답 헤더와 쿠키에 설정한다.
 *
 * @param res Express 응답 객체
 * @param tokenData 설정할 토큰 데이터
 * @returns void
 */
const setTokenCookies = (res: Response, tokenData: TokenPayload) => {
  res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`);
  res.cookie("access_token", tokenData.accessToken, authCookieOptions);
  res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions);
};

const deviceIdFromRequest = (req: Request) => {
  const value = req.headers["x-device-id"];
  const deviceId = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!deviceId) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  return deviceId;
};

@Resolver()
export class AuthResolver {
  /**
   * AuthResolver에서 사용할 AuthService 의존성을 주입한다.
   *
   * @param authService 인증 서비스
   */
  constructor(private readonly authService: AuthService) {}

  /**
   * 일반 회원가입을 처리하고 인증 쿠키를 설정한다.
   *
   * @param input 회원가입 입력값
   * @param res Express 응답 객체
   * @returns 발급된 access token과 refresh token
   */
  @Mutation(() => TokenPayload)
  async signup(@Args("input") input: SignupAuthInput, @Context("req") req: Request, @Context("res") res: Response) {
    const tokenData = await this.authService.signup(input, deviceIdFromRequest(req));
    setTokenCookies(res, tokenData);
    return tokenData;
  }

  /**
   * 이메일 로그인을 처리하고 인증 쿠키를 설정한다.
   *
   * @param input 로그인 입력값
   * @param res Express 응답 객체
   * @returns 발급된 access token과 refresh token
   */
  @Mutation(() => TokenPayload)
  async signin(@Args("input") input: SigninAuthInput, @Context("req") req: Request, @Context("res") res: Response) {
    const tokenData = await this.authService.signin(input, deviceIdFromRequest(req));
    setTokenCookies(res, tokenData);
    return tokenData;
  }

  /**
   * 이메일 가입 여부를 조회한다.
   *
   * @param email 확인할 이메일
   * @returns 가입 여부
   */
  @Query(() => SignedPayload)
  signed(@Args("email") email: string) {
    return this.authService.signed(email);
  }

  /**
   * refresh token으로 새 access token을 발급한다.
   *
   * @param req refresh token 인증 요청 객체
   * @param res Express 응답 객체
   * @returns 새 access token과 refresh token
   */
  @UseGuards(JwtRefreshTokenGuard)
  @Mutation(() => TokenPayload)
  async refresh(@Context("req") req: RefreshAuthRequest, @Context("res") res: Response) {
    const tokenData = await this.authService.refresh(req.user.userId, req.user.deviceId, req.cookies.refresh_token);
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
