import { Field, InputType, ObjectType } from "@nestjs/graphql";

@InputType()
export class UpdateEmailInput {
  @Field()
  email!: string;

  @Field()
  phoneVerificationToken!: string;
}

export type UpdateEmailRepositoryInput = UpdateEmailInput & {
  userId: string;
};

@InputType()
export class UpdatePasswordInput {
  @Field()
  password!: string;

  @Field()
  phoneVerificationToken!: string;
}

export type UpdatePasswordRepositoryInput = UpdatePasswordInput & {
  userId: string;
};

@ObjectType()
export class UserPayload {
  @Field()
  email!: string;

  @Field({ nullable: true })
  phone?: string;

  @Field()
  userName!: string;

  @Field()
  gender!: string;

  @Field()
  intro!: string;
}

@ObjectType()
export class CurrentSubscriptionPayload {
  @Field()
  planId!: string;
}
