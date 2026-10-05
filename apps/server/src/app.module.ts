// SPDX-License-Identifier: MPL-2.0
import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module.js";
import { RunsModule } from "./runs/runs.module.js";

/** Local-only HTTP API: health, and the Runs with their Gates and events. */
@Module({ imports: [HealthModule, RunsModule] })
export class AppModule {}
