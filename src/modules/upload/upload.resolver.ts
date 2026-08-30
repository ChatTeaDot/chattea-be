import { UseGuards } from "@nestjs/common";
import { Args, Context, ID, Mutation, Resolver } from "@nestjs/graphql";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { UploadService } from "./upload.service";
import { CreateUploadInput, CreateUploadPayload, VerifiedUploadPayload } from "./upload.types";

@Resolver()
export class UploadResolver {
  constructor(private readonly uploadService: UploadService) {}

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => CreateUploadPayload)
  createUpload(@Context("req") req: AuthRequest, @Args("input") input: CreateUploadInput) {
    return this.uploadService.createUpload({ ...input, userId: req.user.userId });
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => VerifiedUploadPayload)
  finalizeUpload(@Context("req") req: AuthRequest, @Args("uploadId", { type: () => ID }) uploadId: string) {
    return this.uploadService.finalizeUpload(req.user.userId, uploadId);
  }
}
