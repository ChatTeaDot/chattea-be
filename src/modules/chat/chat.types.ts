import { Field, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class ChatRoomPayload {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  lastMessage!: string | null;
}

@ObjectType()
export class ChatMessagePayload {
  @Field()
  id!: string;

  @Field()
  roomId!: string;

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
export class SetTypingInput {
  @Field()
  roomId!: string;

  @Field()
  typing!: boolean;
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
