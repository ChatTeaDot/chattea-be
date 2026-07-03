import { Field, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class MatchCandidatePayload {
  @Field()
  id!: string;

  @Field()
  userName!: string;

  @Field()
  intro!: string;

  @Field()
  likedByMe!: boolean;

  @Field()
  planId!: string;

  @Field()
  blackRecommended!: boolean;
}

@ObjectType()
export class LikeUserPayload {
  @Field()
  matched!: boolean;

  @Field({ nullable: true })
  roomId?: string;
}
