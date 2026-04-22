import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/aws/asgCommands", () => ({
  terminateAndScaleDown: vi.fn(),
  getAutoScalingGroupState: vi.fn(),
  setDesiredCapacityIfChanged: vi.fn(),
}));

vi.mock("db/client", () => ({
  prisma: {
    projectRoom: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../../services/redisManager", () => ({
  getInstance: vi.fn(),
  deleteInstanceLifecycle: vi.fn(),
  withDistributedLock: vi.fn(),
}));

vi.mock("../../../services/projectRuntimeTruthSource", () => ({
  getAssignedProjectByInstanceId: vi.fn(),
  listBusyInstanceIds: vi.fn(),
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  createScopedLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../../lib/aws/ec2Commands", () => ({
  getPublicIP: vi.fn(),
}));

vi.mock("../../../lib/vmAgent/client", () => ({
  probeVmAgentHealth: vi.fn(),
}));

import { computeScalingPlan } from "../../../services/asgManager";

describe("asgManager.computeScalingPlan", () => {
  it("returns SCALE_UP when idle count is below the minimum", () => {
    const result = computeScalingPlan({
      totalInstances: 1,
      desiredCapacity: 1,
      healthyInServiceCount: 1,
      unhealthyCount: 0,
      idleCount: 0,
      busyCount: 1,
      idleInstanceIds: [],
    });

    expect(result).toEqual({
      action: "SCALE_UP",
      targetDesiredCapacity: 3,
      reason: "Idle count 0 is below min idle 2",
    });
  });

  it("returns KEEP when idle count is within the target band", () => {
    const result = computeScalingPlan({
      totalInstances: 4,
      desiredCapacity: 4,
      healthyInServiceCount: 4,
      unhealthyCount: 0,
      idleCount: 3,
      busyCount: 1,
      idleInstanceIds: ["i-1", "i-2", "i-3"],
    });

    expect(result).toEqual({
      action: "KEEP",
      reason: "Idle count 3 is within target band 2-5",
    });
  });

  it("returns RECYCLE_IDLE when idle count is above the maximum", () => {
    const result = computeScalingPlan({
      totalInstances: 7,
      desiredCapacity: 7,
      healthyInServiceCount: 7,
      unhealthyCount: 0,
      idleCount: 6,
      busyCount: 1,
      idleInstanceIds: ["i-1", "i-2", "i-3", "i-4", "i-5", "i-6"],
    });

    expect(result).toEqual({
      action: "RECYCLE_IDLE",
      instanceIds: ["i-1"],
      reason: "Idle count 6 is above max idle",
    });
  });

  it("returns KEEP when unhealthy instances exist", () => {
    const result = computeScalingPlan({
      totalInstances: 4,
      desiredCapacity: 4,
      healthyInServiceCount: 3,
      unhealthyCount: 1,
      idleCount: 0,
      busyCount: 3,
      idleInstanceIds: [],
    });

    expect(result).toEqual({
      action: "KEEP",
      reason: "Unhealthy instances are handled seperately before scale decisions",
    });
  });
});