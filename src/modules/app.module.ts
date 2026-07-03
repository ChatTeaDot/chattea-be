import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { PhoneModule } from "./phone/phone.module";
import { UserModule } from "./user/user.module";
import { ChatModule } from "./chat/chat.module";
import { CommunityModule } from "./community/community.module";
import { MatchingModule } from "./matching/matching.module";
import { ScoreModule } from "./score/score.module";
import { SubscriptionModule } from "./subscription/subscription.module";
import { UploadModule } from "./upload/upload.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      context: ({ req, res }) => ({ req, res }),
    }),
    DatabaseModule,
    AuthModule,
    PhoneModule,
    UserModule,
    SubscriptionModule,
    ChatModule,
    CommunityModule,
    MatchingModule,
    ScoreModule,
    UploadModule,
  ],
})
export class AppModule {}
