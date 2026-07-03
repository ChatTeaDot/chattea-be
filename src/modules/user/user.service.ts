import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { CustomNotFoundException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { UserErrorMessage } from "./user.error";
import { UserRepository } from "./user.repository";
import { UpdateEmailRepositoryInput, UpdatePasswordRepositoryInput } from "./user.types";

@Injectable()
export class UserService {
  /**
   * UserService에서 사용할 UserRepository 의존성을 주입한다.
   *
   * @param userRepository 사용자 저장소
   */
  constructor(private readonly userRepository: UserRepository) {}

  /**
   * userId로 사용자를 조회하고 없으면 예외를 던진다.
   *
   * @param userId 사용자 ID
   * @returns 조회된 사용자
   * @throws {CustomNotFoundException} 사용자가 없을 때
   */
  async findUser(userId: string) {
    const user = await this.userRepository.findUser(userId);
    if (!user) throw new CustomNotFoundException(UserErrorMessage.InvalidUserId);
    return user;
  }

  /**
   * 전화번호 인증 토큰을 확인한 뒤 이메일을 변경한다.
   *
   * @param input 이메일 변경 입력값
   * @returns 갱신된 사용자 목록
   * @throws {CustomUnauthorizedException} 전화번호 인증 토큰이 유효하지 않을 때
   */
  async updateEmail(input: UpdateEmailRepositoryInput) {
    await this.assertVerifiedPhoneToken(input.userId, input.phoneVerificationToken);
    return this.userRepository.updateEmail(input);
  }

  /**
   * 전화번호 인증 토큰을 확인한 뒤 비밀번호를 변경한다.
   *
   * @param input 비밀번호 변경 입력값
   * @returns 갱신된 사용자 목록
   * @throws {CustomUnauthorizedException} 전화번호 인증 토큰이 유효하지 않을 때
   */
  async updatePassword(input: UpdatePasswordRepositoryInput) {
    await this.assertVerifiedPhoneToken(input.userId, input.phoneVerificationToken);
    const password = await bcrypt.hash(input.password, 10);
    return this.userRepository.updatePassword({ ...input, password });
  }

  /**
   * phoneVerificationToken이 현재 사용자의 전화번호와 일치하고 만료되지 않았는지 확인한다.
   *
   * @param userId 사용자 ID
   * @param phoneVerificationToken 확인할 phoneVerificationToken
   * @throws {CustomUnauthorizedException} 토큰이 없거나 만료됐거나 사용자 전화번호와 다를 때
   */
  private async assertVerifiedPhoneToken(userId: string, phoneVerificationToken: string) {
    const [user, token] = await Promise.all([
      this.userRepository.findUser(userId),
      this.userRepository.findPhoneVerificationToken(phoneVerificationToken),
    ]);
    if (!token || token.expiresAt.getTime() <= Date.now()) {
      throw new CustomUnauthorizedException(UserErrorMessage.InvalidPhoneVerificationToken);
    }
    if (!user?.phone || user.phone !== token.phoneE164)
      throw new CustomUnauthorizedException(UserErrorMessage.PhoneVerificationRequired);
    if (!(await this.userRepository.consumePhoneVerificationToken(phoneVerificationToken))) {
      throw new CustomUnauthorizedException(UserErrorMessage.InvalidPhoneVerificationToken);
    }
  }
}
