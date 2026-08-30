import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import type { Request, Response } from "express";
import { validateEnvironment } from "src/common/config/environment";
import { graphqlDocumentFieldLimitRule } from "src/common/security/graphql-document-limit";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { PhoneModule } from "./phone/phone.module";
import { UserModule } from "./user/user.module";
import { ChatModule } from "./chat/chat.module";
import { CommunityModule } from "./community/community.module";
import { MatchingModule } from "./matching/matching.module";
import { UploadModule } from "./upload/upload.module";
import { NotificationModule } from "./notification/notification.module";
import { BillingModule } from "./billing/billing.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validate: validateEnvironment,
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      context: ({ req, res }: { req: Request; res: Response }) => ({ req, res }),
      introspection: process.env.NODE_ENV !== "production",
      validationRules: [graphqlDocumentFieldLimitRule],
    }),
    DatabaseModule,
    AuthModule,
    PhoneModule,
    UserModule,
    ChatModule,
    CommunityModule,
    MatchingModule,
    UploadModule,
    NotificationModule,
    BillingModule,
  ],
})
export class AppModule {}
