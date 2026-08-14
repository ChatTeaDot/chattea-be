import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

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
export class UploadPayload {
  @Field()
  id!: string;

  @Field()
  putUrl!: string;
}
