import { Field, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class BillingProductPayload {
  @Field()
  id!: string;

  @Field()
  kind!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  priceKrw!: number;
}

@ObjectType()
export class ConsumableBalancePayload {
  @Field(() => Int)
  superLikeCredits!: number;

  @Field(() => Int)
  boostCredits!: number;
}
