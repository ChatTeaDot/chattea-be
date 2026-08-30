import { ProfileUpload } from "src/modules/database/schema";

export type UploadMaintenanceBatchResult = Readonly<{
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  hasMore: boolean;
}>;

export type FinalizeUploadClaim = Readonly<{
  kind: "claimed" | "verified" | "expired" | "busy";
  upload: ProfileUpload;
}>;

export type CleanupUploadClaim = Readonly<{
  jobs: readonly ProfileUpload[];
  hasMore: boolean;
}>;
