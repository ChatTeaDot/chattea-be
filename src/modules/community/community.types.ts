import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class CommunityPostPayload {
  @Field()
  id!: string;

  @Field()
  authorName!: string;

  @Field()
  title!: string;

  @Field()
  body!: string;

  @Field(() => Int)
  commentCount!: number;

  @Field()
  createdAt!: string;
}

@ObjectType()
export class CommunityCommentPayload {
  @Field()
  id!: string;

  @Field()
  postId!: string;

  @Field()
  authorName!: string;

  @Field()
  body!: string;

  @Field()
  createdAt!: string;
}

@InputType()
export class CreateCommunityPostInput {
  @Field()
  title!: string;

  @Field()
  body!: string;
}

@InputType()
export class CreateCommunityCommentInput {
  @Field()
  postId!: string;

  @Field()
  body!: string;
}

@InputType()
export class ReportCommunityPostInput {
  @Field()
  postId!: string;

  @Field()
  reason!: string;
}

@InputType()
export class ReportCommunityCommentInput {
  @Field()
  commentId!: string;

  @Field()
  reason!: string;
}

@ObjectType()
export class CommunityProfilePayload {
  @Field()
  name!: string;
}

@InputType()
export class UpdateCommunityProfileInput {
  @Field()
  name!: string;
}
