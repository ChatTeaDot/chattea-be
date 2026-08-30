import { Module } from "@nestjs/common";
import { R2ObjectStore } from "./r2-object-store";
import { UploadRepository } from "./upload.repository";
import { UploadResolver } from "./upload.resolver";
import { UploadService } from "./upload.service";

@Module({
  providers: [R2ObjectStore, UploadRepository, UploadResolver, UploadService],
  exports: [UploadService],
})
export class UploadModule {}
