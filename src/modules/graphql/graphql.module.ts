import { createSchema } from "graphql-yoga";
import type { AuthService } from "../auth/auth.service.js";
import type { User } from "../auth/session.repository.js";
import type { ChatService } from "../chat/chat.service.js";
import type { CommunityService } from "../community/community.service.js";
import type { PhoneRequestMetadata, PhoneService } from "../auth/phone.service.js";
import type { ProfileRatingService } from "../profile/profile-rating.service.js";
import type { MatchingService } from "../matching/matching.service.js";
import type { SubscriptionService } from "../subscription/subscription.service.js";
import type { UploadService } from "../upload/upload.service.js";
import { createGraphQLResolvers } from "./graphql.resolver.js";
import { graphQLTypeDefs } from "./graphql-type-defs.js";

export type GraphQLContext = {
  authService: AuthService;
  chatService: ChatService;
  communityService: CommunityService;
  currentUser?: User | null;
  matchingService: MatchingService;
  phoneService: PhoneService;
  profileRatingService: ProfileRatingService;
  requestMetadata?: PhoneRequestMetadata;
  subscriptionService: SubscriptionService;
  uploadService: UploadService;
  now?: () => Date;
};

export function makeSchema() {
  return createSchema<GraphQLContext>({
    typeDefs: graphQLTypeDefs,
    resolvers: createGraphQLResolvers(),
  });
}
