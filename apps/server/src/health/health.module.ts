import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HEALTH_REPORTER, HealthService } from "./health.service.js";

@Module({
  controllers: [HealthController],
  providers: [{ provide: HEALTH_REPORTER, useClass: HealthService }],
})
export class HealthModule {}
