import { Field, InputType, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class NotificationPayload {
  @Field()
  id!: string;

  @Field()
  type!: string;

  @Field()
  title!: string;

  @Field()
  body!: string;

  @Field({ nullable: true })
  route?: string;

  @Field({ nullable: true })
  readAt?: string;

  @Field()
  createdAt!: string;
}

@InputType()
export class RegisterPushTokenInput {
  @Field()
  token!: string;

  @Field()
  platform!: string;
}
