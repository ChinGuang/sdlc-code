import { Controller, Get, Inject } from "@nestjs/common";
import {
  HEALTH_REPORTER,
  type HealthReport,
  type HealthReporter,
} from "./health.service.js";

@Controller("health")
export class HealthController {
  #health: HealthReporter;

  constructor(@Inject(HEALTH_REPORTER) health: HealthReporter) {
    this.#health = health;
  }

  @Get()
  health(): HealthReport {
    return this.#health.report();
  }
}
