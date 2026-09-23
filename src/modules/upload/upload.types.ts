import { Field, ID, InputType, Int, ObjectType } from "@nestjs/graphql";

@InputType()
export class CreateUploadInput {
  @Field()
  filename!: string;

  @Field()
  contentType!: string;

  @Field(() => Int)
  sizeBytes!: number;
}

@ObjectType()
export class CreateUploadPayload {
  @Field(() => ID)
  id!: string;

  @Field()
  putUrl!: string;

  @Field()
  expiresAt!: string;
}

@ObjectType()
export class VerifiedUploadPayload {
  @Field(() => ID)
  id!: string;

  @Field()
  publicUrl!: string;

  @Field()
  contentType!: string;

  @Field(() => Int)
  sizeBytes!: number;
}
