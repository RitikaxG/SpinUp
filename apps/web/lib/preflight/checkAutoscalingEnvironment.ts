import { getAutoScalingGroupState } from "../aws/asgCommands";
import { AUTOSCALING_CONFIG } from "../autoscaling/config";
import { assertEnvPresent } from "../config/env";
import type { PreflightCheckResult } from "./types";

export const checkAutoscalingEnvironment = async (): Promise<PreflightCheckResult> => {
  try {
    assertEnvPresent([
      "EC2_LAUNCHER_ACCESS_KEY",
      "EC2_LAUNCHER_ACCESS_SECRET",
      "ASG_NAME",
    ]);

    const state = await getAutoScalingGroupState();

    const failures: string[] = [];

    if (state.groupName !== AUTOSCALING_CONFIG.ASG_NAME) {
      failures.push(
        `Configured ASG_NAME=${AUTOSCALING_CONFIG.ASG_NAME} but AWS resolved groupName=${state.groupName}`,
      );
    }

    if (AUTOSCALING_CONFIG.MAX_TOTAL_INSTANCES > state.maxSize) {
      failures.push(
        `MAX_TOTAL_INSTANCES=${AUTOSCALING_CONFIG.MAX_TOTAL_INSTANCES} exceeds ASG maxSize=${state.maxSize}`,
      );
    }

    if (AUTOSCALING_CONFIG.MIN_IDLE > AUTOSCALING_CONFIG.MAX_IDLE) {
      failures.push(
        `MIN_IDLE=${AUTOSCALING_CONFIG.MIN_IDLE} is greater than MAX_IDLE=${AUTOSCALING_CONFIG.MAX_IDLE}`,
      );
    }

    if (AUTOSCALING_CONFIG.MIN_IDLE > AUTOSCALING_CONFIG.MAX_TOTAL_INSTANCES) {
      failures.push(
        `MIN_IDLE=${AUTOSCALING_CONFIG.MIN_IDLE} exceeds MAX_TOTAL_INSTANCES=${AUTOSCALING_CONFIG.MAX_TOTAL_INSTANCES}`,
      );
    }

    if (failures.length > 0) {
      return {
        name: "autoscaling-environment",
        status: "FAIL",
        summary: "ASG exists, but local autoscaling assumptions do not match the real environment",
        fatal: true,
        details: {
          failures,
          liveState: state,
          configured: AUTOSCALING_CONFIG,
        },
      };
    }

    return {
      name: "autoscaling-environment",
      status: "PASS",
      summary: "ASG exists and autoscaling config matches live AWS state",
      fatal: true,
      details: {
        groupName: state.groupName,
        desiredCapacity: state.desiredCapacity,
        minSize: state.minSize,
        maxSize: state.maxSize,
        totalInstances: state.totalInstances,
      },
    };
  } catch (err) {
    return {
      name: "autoscaling-environment",
      status: "FAIL",
      summary: "Autoscaling environment preflight failed",
      fatal: true,
      details: {
        error: err instanceof Error ? err.message : "Unknown ASG preflight error",
      },
    };
  }
};