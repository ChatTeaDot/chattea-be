import { UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { UserService } from "./user.service";
import { AccountDeletionPayload, CurrentSubscriptionPayload, UpdateUserProfileInput, UserPayload } from "./user.types";

@Resolver()
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => UserPayload)
  async me(@Context("req") req: AuthRequest) {
    return toUserPayload(await this.userService.profile(req.user.userId));
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => CurrentSubscriptionPayload)
  currentSubscription(@Context("req") req: AuthRequest) {
    return this.userService.currentSubscription(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => UserPayload)
  async updateUserProfile(@Context("req") req: AuthRequest, @Args("input") input: UpdateUserProfileInput) {
    return toUserPayload(await this.userService.updateProfile(req.user.userId, input));
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => AccountDeletionPayload)
  requestAccountDeletion(@Context("req") req: AuthRequest) {
    return this.userService.beginAccountDeletion(req.user.userId);
  }
}

const toUserPayload = (user: Awaited<ReturnType<UserService["profile"]>>): UserPayload => ({
  id: user.userId,
  email: user.email,
  phone: user.phone ?? undefined,
  userName: user.userName,
  gender: user.gender,
  intro: user.intro,
  birthDate: user.birthDate ?? undefined,
  region: user.region ?? undefined,
  interestedGender: user.interestedGender ?? undefined,
  photos: user.photos.map((photo) => ({ id: photo.uploadId ?? photo.id, url: photo.url, position: photo.position })),
  profileCompleted: Boolean(user.profileCompletedAt && user.photos.length >= 1),
});
