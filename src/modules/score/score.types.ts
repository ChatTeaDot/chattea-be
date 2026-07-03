import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

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
