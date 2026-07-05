export enum AuthErrorMessage {
  AuthRequired = "로그인 필요합니다.",
  InvalidPhoneVerificationToken = "phoneVerificationToken이 잘못되었습니다.",
  InvalidKakaoPhoneVerificationToken = "kakaoPhoneVerificationToken이 잘못되었습니다.",
  InvalidGender = "성별이 잘못되었습니다.",
  PhoneVerificationRequired = "전화번호 인증이 필요합니다.",
  InvalidOauthState = "OAuth state가 잘못되었습니다.",
  DuplicateUser = "이미 가입된 이메일 또는 전화번호입니다.",
  RefreshTokenUndefined = "refresh token is undefined",
  RefreshTokenWrong = "refresh token is wrong",
  RefreshTokenExpUndefined = "refresh token exp is undefined",
}
