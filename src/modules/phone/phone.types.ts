import { Field, InputType, ObjectType, registerEnumType } from "@nestjs/graphql";
import { TokenPayload } from "src/modules/auth/auth.types";

export enum PhoneVerificationPurpose {
  Signup = "signup",
  Login = "login",
  PasswordReset = "password_reset",
}

registerEnumType(PhoneVerificationPurpose, { name: "PhoneVerificationPurpose" });

@InputType()
export class RequestPhoneCodeInput {
  @Field()
  phone!: string;

  @Field(() => PhoneVerificationPurpose)
  purpose!: PhoneVerificationPurpose;
}

@ObjectType()
export class RequestPhoneCodePayload {
  @Field()
  ok!: boolean;
}

@InputType()
export class VerifyPhoneCodeInput {
  @Field()
  phone!: string;

  @Field()
  code!: string;
}

@ObjectType()
export class VerifyPhoneCodePayload {
  @Field()
  existingUser!: boolean;

  @Field({ nullable: true })
  phoneVerificationToken?: string;

  @Field(() => TokenPayload, { nullable: true })
  tokenPayload?: TokenPayload;
}

@InputType()
export class CompletePhoneSignupInput {
  @Field()
  phoneVerificationToken!: string;

  @Field()
  email!: string;

  @Field()
  password!: string;

  @Field({ nullable: true })
  userName?: string;

  @Field()
  gender!: string;

  @Field(() => Boolean)
  termsAccepted!: boolean;
}

@InputType()
export class CompleteKakaoPhoneSignupInput {
  @Field()
  phoneVerificationToken!: string;

  @Field()
  kakaoPhoneVerificationToken!: string;

  @Field()
  userName!: string;

  @Field()
  gender!: string;

  @Field(() => Boolean)
  termsAccepted!: boolean;
}

@InputType()
export class ResetPasswordWithPhoneInput {
  @Field()
  phone!: string;

  @Field()
  code!: string;

  @Field()
  password!: string;
}
