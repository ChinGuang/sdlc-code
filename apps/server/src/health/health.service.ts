import { Injectable } from "@nestjs/common";
import { AGENT_ROLES } from "@sdlc-code/core";

export type HealthReport = { status: "ok"; agentRoles: number };

/** Reports server liveness. Controllers depend on this, not on HealthService. */
export interface HealthReporter {
  report: () => HealthReport;
}

/** Nest injection token for HealthReporter (interfaces vanish at runtime). */
export const HEALTH_REPORTER = Symbol("HealthReporter");

@Injectable()
export class HealthService implements HealthReporter {
  report = (): HealthReport => ({
    status: "ok",
    agentRoles: AGENT_ROLES.length,
  });
}
