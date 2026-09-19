import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module.js";

/** Local-only HTTP API. T21 adds runs, gates and the SSE stream. */
@Module({ imports: [HealthModule] })
export class AppModule {}
