import { type Request } from "express";
import { validate, version } from "uuid";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "./auth.error";

export const deviceIdFromRequest = (req: Request): string => {
  const value = req.headers["x-device-id"];
  const deviceId = typeof value === "string" ? value.trim() : "";
  if (!validate(deviceId) || version(deviceId) !== 4) {
    throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  }
  return deviceId;
};
