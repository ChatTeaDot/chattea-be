import { Module } from "@nestjs/common";
import { ScoreResolver } from "./score.resolver";
import { ScoreRepository } from "./score.repository";
import { ScoreService } from "./score.service";

@Module({
  providers: [ScoreResolver, ScoreService, ScoreRepository],
})
export class ScoreModule {}
