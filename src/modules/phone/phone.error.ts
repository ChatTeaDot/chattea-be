export enum PhoneErrorMessage {
  InvalidPhoneCode = "인증번호가 잘못되었습니다.",
  ExpiredPhoneCode = "인증번호가 만료되었습니다.",
  PhoneCodeRetryTooSoon = "인증번호 재요청은 60초 후 가능합니다.",
  PhoneRequestLimitExceeded = "전화번호 요청 횟수를 초과했습니다.",
  IpRequestLimitExceeded = "IP 요청 횟수를 초과했습니다.",
  PhoneCodeAttemptLimitExceeded = "인증 실패 횟수를 초과했습니다.",
  KoreanPhoneOnly = "한국 휴대폰 번호만 사용할 수 있습니다.",
  InvalidPhonePurpose = "전화번호 인증 목적이 잘못되었습니다.",
  InvalidPhoneVerificationToken = "phoneVerificationToken이 잘못되었습니다.",
  PhoneVerificationRequired = "전화번호 인증이 필요합니다.",
  SmsSendFailed = "인증번호 발송에 실패했습니다.",
}
