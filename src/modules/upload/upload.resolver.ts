import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { UploadService } from "./upload.service";
import { CreateUploadInput, UploadPayload } from "./upload.types";

@Resolver()
export class UploadResolver {
  /**
   * UploadResolver에서 사용할 UploadService 의존성을 주입한다.
   *
   * @param uploadService 업로드 서비스
   */
  constructor(private readonly uploadService: UploadService) {}

  /**
   * 이미지 업로드 URL을 생성한다.
   *
   * @param input 업로드 생성 입력값
   * @returns 업로드 ID와 PUT URL
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => UploadPayload)
  createUpload(@Context("req") req: AuthRequest, @Args("input") input: CreateUploadInput) {
    return this.uploadService.createUpload({ ...input, userId: req.user.userId });
  }
}
