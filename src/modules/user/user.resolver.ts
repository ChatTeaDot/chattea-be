import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { UserService } from "./user.service";
import { UpdateEmailInput, UpdatePasswordInput, UserPayload } from "./user.types";

@Resolver()
export class UserResolver {
  /**
   * UserResolver에서 사용할 UserService 의존성을 주입한다.
   *
   * @param userService 사용자 서비스
   */
  constructor(private readonly userService: UserService) {}

  /**
   * 현재 로그인한 사용자의 프로필을 조회한다.
   *
   * @param req 인증 요청 객체
   * @returns 사용자 프로필
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => UserPayload)
  async me(@Context("req") req: AuthRequest) {
    const user = await this.userService.findUser(req.user.userId);
    return { email: user.email, phone: user.phone ?? undefined, userName: user.userName, intro: user.intro };
  }

  /**
   * 현재 로그인한 사용자의 이메일을 변경한다.
   *
   * @param req 인증 요청 객체
   * @param input 이메일 변경 입력값
   * @returns 변경 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  async updateEmail(@Context("req") req: AuthRequest, @Args("input") input: UpdateEmailInput) {
    await this.userService.updateEmail({ ...input, userId: req.user.userId });
    return true;
  }

  /**
   * 현재 로그인한 사용자의 비밀번호를 변경한다.
   *
   * @param req 인증 요청 객체
   * @param input 비밀번호 변경 입력값
   * @returns 변경 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  async updatePassword(@Context("req") req: AuthRequest, @Args("input") input: UpdatePasswordInput) {
    await this.userService.updatePassword({ ...input, userId: req.user.userId });
    return true;
  }
}
