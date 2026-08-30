import { createUnionType, Field, ObjectType } from "@nestjs/graphql";
import { Request } from "express";
import { Gender, RefreshToken } from "src/modules/database/schema";
import { AccessTokenClaims, RefreshTokenClaims } from "./token-claims";

export type JwtPayload = AccessTokenClaims;

export type AuthRequest = Request & {
  user: JwtPayload;
  cookies: {
    access_token?: string;
    refresh_token?: string;
  };
};

export type RefreshAuthRequest = Request & {
  user: RefreshTokenClaims;
  validatedRefreshToken: RefreshToken;
  cookies: {
    refresh_token?: string;
  };
};

export type KakaoRequest = Request & {
  user: KakaoProfile;
};

export type KakaoRawProfile = {
  id: string;
  _json?: {
    kakao_account?: {
      email?: string;
    };
  };
};

export type SignupAuthInput = {
  email: string;
  password: string;
  userName: string;
  gender: Gender;
  phoneVerificationToken: string;
  termsAccepted: boolean;
};

export type SignupAuthRepositoryInput = SignupAuthInput & {
  userId: string;
  phone: string;
};

export type KakaoProfile = {
  providerUserId: string;
  email?: string;
  userName?: string;
};

export type KakaoLoginResult = {
  kakaoPhoneVerificationToken: string;
};

export type SigninAuthInput = {
  email: string;
  password: string;
  phoneVerificationToken: string;
};

@ObjectType()
export class TokenPayload {
  @Field()
  accessToken!: string;

  @Field()
  refreshToken!: string;
}

@ObjectType()
export class KakaoLoginSuccessPayload {
  @Field(() => Boolean)
  requiresPhone!: boolean;

  @Field(() => TokenPayload)
  session!: TokenPayload;
}

@ObjectType()
export class KakaoRequiresPhonePayload {
  @Field(() => Boolean)
  requiresPhone!: boolean;

  @Field()
  kakaoPhoneVerificationToken!: string;

  @Field(() => String, { nullable: true })
  userName!: string | null;
}

export const KakaoLoginPayload = createUnionType({
  name: "KakaoLoginPayload",
  types: () => [KakaoLoginSuccessPayload, KakaoRequiresPhonePayload] as const,
  resolveType: (value) => (value.requiresPhone ? KakaoRequiresPhonePayload : KakaoLoginSuccessPayload),
});
