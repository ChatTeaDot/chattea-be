import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class MatchPhotoPayload {
  @Field()
  url!: string;

  @Field(() => Int)
  position!: number;
}

@ObjectType()
export class MatchCandidatePayload {
  @Field()
  id!: string;

  @Field()
  userName!: string;

  @Field()
  gender!: string;

  @Field(() => Int)
  age!: number;

  @Field()
  region!: string;

  @Field()
  intro!: string;

  @Field(() => [MatchPhotoPayload])
  photos!: MatchPhotoPayload[];

  @Field()
  likedByMe!: boolean;

  @Field()
  planId!: string;

  @Field()
  blackRecommended!: boolean;

  @Field()
  boostActive!: boolean;
}

@ObjectType()
export class LikeUserPayload {
  @Field()
  matched!: boolean;

  @Field({ nullable: true })
  roomId?: string;

  @Field()
  undoAvailable!: boolean;
}

@ObjectType()
export class UndoMatchActionPayload {
  @Field()
  reverted!: boolean;

  @Field({ nullable: true })
  targetUserId?: string;
}

@ObjectType()
export class BoostPayload {
  @Field()
  activeUntil!: string;

  @Field(() => Int)
  remainingBoostCredits!: number;
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
