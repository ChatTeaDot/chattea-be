import { Module } from "@nestjs/common";
import { UserModule } from "src/modules/user/user.module";
import { MatchingResolver } from "./matching.resolver";
import { MatchingRepository } from "./matching.repository";
import { MatchingService } from "./matching.service";

@Module({
  imports: [UserModule],
  providers: [MatchingResolver, MatchingService, MatchingRepository],
})
export class MatchingModule {}
