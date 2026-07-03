import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class SubscriptionPlanPayload {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  monthlyPriceKrw!: number;

  @Field(() => [String])
  benefits!: string[];
}

@ObjectType()
export class CurrentSubscriptionPayload {
  @Field()
  planId!: string;
}

@InputType()
export class UnreadMessageSummaryInput {
  @Field()
  planId!: string;

  @Field(() => [String])
  unreadTexts!: string[];

  @Field()
  enabled!: boolean;
}

@ObjectType()
export class AiSummaryPreviewPayload {
  @Field()
  available!: boolean;

  @Field({ nullable: true })
  reason?: string;

  @Field()
  sourceText!: string;

  @Field({ nullable: true })
  summary?: string;
}
