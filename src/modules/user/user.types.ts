import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

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
export class ProfilePhotoPayload {
  @Field()
  id!: string;

  @Field()
  url!: string;

  @Field(() => Int)
  position!: number;
}

@InputType()
export class UpdateUserProfileInput {
  @Field()
  userName!: string;

  @Field()
  birthDate!: string;

  @Field()
  region!: string;

  @Field()
  interestedGender!: string;

  @Field()
  intro!: string;

  @Field(() => [String])
  photoUrls!: string[];
}

@ObjectType()
export class UserPayload {
  @Field()
  id!: string;

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

  @Field({ nullable: true })
  birthDate?: string;

  @Field({ nullable: true })
  region?: string;

  @Field({ nullable: true })
  interestedGender?: string;

  @Field(() => [ProfilePhotoPayload])
  photos!: ProfilePhotoPayload[];

  @Field()
  profileCompleted!: boolean;
}

@ObjectType()
export class CurrentSubscriptionPayload {
  @Field()
  planId!: string;
}

@ObjectType()
export class AccountDeletionPayload {
  @Field()
  hidden!: boolean;

  @Field()
  scheduledFor!: string;
}
