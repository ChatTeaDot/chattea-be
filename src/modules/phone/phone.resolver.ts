import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { authCookieOptions } from "src/modules/auth/cookie-options";
import { deviceIdFromRequest } from "src/modules/auth/device-id";
import { PhoneService } from "./phone.service";
import {
  CompleteKakaoPhoneSignupInput,
  CompletePhoneSignupInput,
  RequestPhoneCodeInput,
  RequestPhoneCodePayload,
  ResetPasswordWithPhoneInput,
  VerifyPhoneCodeInput,
  VerifyPhoneCodePayload,
} from "./phone.types";
import { TokenPayload } from "src/modules/auth/auth.types";
import { Request, Response } from "express";

const setTokenCookies = (res: Response, tokenData: TokenPayload) => {
  res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`);
  res.cookie("access_token", tokenData.accessToken, authCookieOptions);
  res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions);
};

@Resolver()
export class PhoneResolver {
  constructor(private readonly phoneService: PhoneService) {}

  @Mutation(() => RequestPhoneCodePayload)
  requestPhoneCode(@Args("input") input: RequestPhoneCodeInput, @Context("req") req: Request) {
    return this.phoneService.requestPhoneCode(input, req.ip, req.headers["user-agent"]);
  }

  @Mutation(() => VerifyPhoneCodePayload)
  verifyPhoneCode(@Args("input") input: VerifyPhoneCodeInput, @Context("req") req: Request) {
    return this.phoneService.verifyPhoneCode(input, deviceIdFromRequest(req));
  }

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

  @Mutation(() => Boolean)
  resetPasswordWithPhone(@Args("input") input: ResetPasswordWithPhoneInput) {
    return this.phoneService.resetPasswordWithPhone(input);
  }
}
