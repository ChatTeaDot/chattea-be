import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class ChatRoomPayload {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  lastMessage!: string | null;

  @Field(() => Int)
  unreadCount!: number;
}

@ObjectType()
export class ChatMessagePayload {
  @Field()
  id!: string;

  @Field()
  roomId!: string;

  @Field({ nullable: true })
  senderUserId?: string;

  @Field()
  text!: string;

  @Field({ nullable: true })
  idempotencyKey?: string;

  @Field()
  createdAt!: string;
}

@InputType()
export class ChatMessagesInput {
  @Field()
  roomId!: string;

  @Field(() => Int, { nullable: true })
  first?: number;

  @Field({ nullable: true })
  after?: string;
}

@InputType()
export class SendChatMessageInput {
  @Field()
  roomId!: string;

  @Field()
  text!: string;

  @Field({ nullable: true })
  idempotencyKey?: string;
}

@InputType()
export class EditChatMessageInput {
  @Field()
  messageId!: string;

  @Field()
  text!: string;
}

@InputType()
export class MarkRoomReadInput {
  @Field()
  roomId!: string;
}

@InputType()
export class BlockUserInput {
  @Field()
  userId!: string;
}

@InputType()
export class ReportMessageInput {
  @Field()
  messageId!: string;

  @Field()
  reason!: string;
}
