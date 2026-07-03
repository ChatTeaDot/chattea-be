import { Field, InputType, ObjectType } from "@nestjs/graphql";
import { Request } from "express";

export type JwtPayload = {
  userId: string;
  deviceId?: string;
};

export type AuthRequest = Request & {
  user: JwtPayload;
  cookies: {
    access_token?: string;
    refresh_token?: string;
  };
};

export type RefreshAuthRequest = Request & {
  user: JwtPayload & { deviceId: string };
  cookies: {
    refresh_token: string;
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

@InputType()
export class SignupAuthInput {
  @Field()
  email!: string;

  @Field()
  password!: string;

  @Field()
  userName!: string;

  @Field()
  phoneVerificationToken!: string;
}

export type SignupAuthRepositoryInput = SignupAuthInput & {
  userId: string;
  phone: string;
};

export type KakaoProfile = {
  providerUserId: string;
  email?: string;
};

export type KakaoLoginResult = {
  kakaoPhoneVerificationToken: string;
};

@InputType()
export class SigninAuthInput {
  @Field()
  email!: string;

  @Field()
  password!: string;

  @Field()
  phoneVerificationToken!: string;
}

@ObjectType()
export class TokenPayload {
  @Field()
  accessToken!: string;

  @Field()
  refreshToken!: string;
}

@ObjectType()
export class SignedPayload {
  @Field()
  isSigned!: boolean;
}
