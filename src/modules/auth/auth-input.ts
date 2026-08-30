import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "./auth.error";

const EMAIL_MAX_LENGTH = 255;
const USER_NAME_MAX_LENGTH = 40;
const PASSWORD_MIN_BYTES = 8;
const BCRYPT_PASSWORD_MAX_BYTES = 72;
const EMAIL_PATTERN = /^[^\s@.]+(?:\.[^\s@.]+)*@[^\s@.]+(?:\.[^\s@.]+)+$/u;

const isValidEmail = (email: string): boolean =>
  EMAIL_PATTERN.test(email) && Array.from(email).length <= EMAIL_MAX_LENGTH;

export const normalizeEmail = (input: string): string => {
  const email = input.trim();
  if (!isValidEmail(email)) {
    throw new CustomBadRequestException(AuthErrorMessage.InvalidEmail);
  }
  return email;
};

export const normalizeOptionalEmail = (input?: string): string | undefined => {
  if (input === undefined) return undefined;
  const email = input.trim();
  return isValidEmail(email) ? email : undefined;
};

export const normalizeUserName = (input: string): string => {
  const userName = input.trim();
  if (!userName || Array.from(userName).length > USER_NAME_MAX_LENGTH) {
    throw new CustomBadRequestException(AuthErrorMessage.InvalidUserName);
  }
  return userName;
};

export const normalizeOptionalUserName = (input?: string): string | undefined => {
  const userName = input?.trim();
  if (!userName) return undefined;
  return Array.from(userName).slice(0, USER_NAME_MAX_LENGTH).join("");
};

export const validatePassword = (input: string): string => {
  const byteLength = Buffer.byteLength(input, "utf8");
  if (byteLength < PASSWORD_MIN_BYTES || byteLength > BCRYPT_PASSWORD_MAX_BYTES) {
    throw new CustomBadRequestException(AuthErrorMessage.InvalidPassword);
  }
  return input;
};

export const normalizeSigninEmail = (input: string): string => {
  const email = input.trim();
  if (!email || Array.from(email).length > EMAIL_MAX_LENGTH) {
    throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  }
  return email;
};
