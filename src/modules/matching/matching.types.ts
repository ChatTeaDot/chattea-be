import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class MatchCandidatePayload {
  @Field()
  id!: string;

  @Field()
  userName!: string;

  @Field()
  gender!: string;

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

@ObjectType()
export class ScoreSummaryPayload {
  @Field()
  userId!: string;

  @Field()
  averageScore!: number;

  @Field(() => Int)
  scoreCount!: number;
}

@InputType()
export class RateScoreInput {
  @Field()
  userId!: string;

  @Field(() => Int)
  score!: number;
}
