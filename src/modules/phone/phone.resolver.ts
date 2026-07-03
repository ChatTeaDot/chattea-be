import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "src/modules/auth/auth.error";
import { authCookieOptions } from "src/modules/auth/cookie-options";
import { PhoneService } from "./phone.service";
import {
  AttachPhoneToMeInput,
  CompleteKakaoPhoneSignupInput,
  CompletePhoneSignupInput,
  RequestPhoneCodeInput,
  RequestPhoneCodePayload,
  ResetPasswordWithPhoneInput,
  VerifyPhoneCodeInput,
  VerifyPhoneCodePayload,
} from "./phone.types";
import { AuthRequest, TokenPayload } from "src/modules/auth/auth.types";
import { Request, Response } from "express";

const deviceIdFromRequest = (req: Request) => {
  const value = req.headers["x-device-id"];
  const deviceId = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!deviceId) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  return deviceId;
};

const setTokenCookies = (res: Response, tokenData: TokenPayload) => {
  res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`);
  res.cookie("access_token", tokenData.accessToken, authCookieOptions);
  res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions);
};

@Resolver()
export class PhoneResolver {
  /**
   * PhoneResolver에서 사용할 PhoneService 의존성을 주입한다.
   *
   * @param phoneService 전화번호 서비스
   */
  constructor(private readonly phoneService: PhoneService) {}

  /**
   * 전화번호 인증 코드를 요청한다.
   *
   * @param input 인증 코드 요청 입력값
   * @param req Express 요청 객체
   * @returns 요청 성공 여부
   */
  @Mutation(() => RequestPhoneCodePayload)
  requestPhoneCode(@Args("input") input: RequestPhoneCodeInput, @Context("req") req: Request) {
    return this.phoneService.requestPhoneCode(input, req.ip, req.headers["user-agent"]);
  }

  @Mutation(() => VerifyPhoneCodePayload)
  verifyPhoneCode(@Args("input") input: VerifyPhoneCodeInput, @Context("req") req: Request) {
    return this.phoneService.verifyPhoneCode(input, deviceIdFromRequest(req));
  }

  /**
   * 전화번호 인증 기반 회원가입을 완료한다.
   *
   * @param input 전화번호 회원가입 완료 입력값
   * @returns 발급된 access token과 refresh token
   */
  @Mutation(() => TokenPayload)
  async completePhoneSignup(
    @Args("input") input: CompletePhoneSignupInput,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const tokenData = await this.phoneService.completePhoneSignup(input, deviceIdFromRequest(req));
    setTokenCookies(res, tokenData);
    return tokenData;
  }

  /**
   * 카카오 로그인 후 전화번호 인증 기반 가입을 완료한다.
   *
   * @param input 카카오 전화번호 가입 완료 입력값
   * @returns 발급된 access token과 refresh token
   */
  @Mutation(() => TokenPayload)
  async completeKakaoPhoneSignup(
    @Args("input") input: CompleteKakaoPhoneSignupInput,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const tokenData = await this.phoneService.completeKakaoPhoneSignup(input, deviceIdFromRequest(req));
    setTokenCookies(res, tokenData);
    return tokenData;
  }

  /**
   * 전화번호 인증으로 비밀번호를 재설정한다.
   *
   * @param input 비밀번호 재설정 입력값
   * @returns 재설정 성공 여부
   */
  @Mutation(() => Boolean)
  resetPasswordWithPhone(@Args("input") input: ResetPasswordWithPhoneInput) {
    return this.phoneService.resetPasswordWithPhone(input);
  }

  /**
   * 로그인한 사용자에게 인증된 전화번호를 연결한다.
   *
   * @param req 인증 요청 객체
   * @param input 전화번호 연결 입력값
   * @returns 연결 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  attachPhoneToMe(@Context("req") req: AuthRequest, @Args("input") input: AttachPhoneToMeInput) {
    return this.phoneService.attachPhoneToMe(req.user.userId, input);
  }
}
