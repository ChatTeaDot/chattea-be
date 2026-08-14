import { Field, InputType, ObjectType } from "@nestjs/graphql";

@InputType()
export class CreateUploadInput {
  @Field()
  filename!: string;

  @Field()
  contentType!: string;
}

@ObjectType()
export class UploadPayload {
  @Field()
  id!: string;

  @Field()
  putUrl!: string;

  @Field()
  publicUrl!: string;
}
