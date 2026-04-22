import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeProject,
  makeRuntimeAssignment,
} from "../../factories/project";

const mocks = vi.hoisted(() => {
  return {
    getIdleMachines: vi.fn(),
    ensureIdleCapacityForAllocation: vi.fn(),
    terminateAndScaleDown: vi.fn(),
    terminateAndReplace: vi.fn(),
    waitForPublicIP: vi.fn(),
    waitForVmAgentHealthy: vi.fn(),
    startVmContainer: vi.fn(),
    waitForRuntimeReady: vi.fn(),
    deleteInstanceLifecycle: vi.fn(),
    cleanupProjectRuntimeAssignment: vi.fn(),
    rehydrateProjectRuntimeRedis: vi.fn(),
    mirrorProjectAssignmentToRedis: vi.fn(),
    prisma: {
      project: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      projectRoom: {
        updateMany: vi.fn(),
      },
    },
    markProjectBooting: vi.fn(),
    markProjectFailed: vi.fn(),
    markProjectReady: vi.fn(),
    getProjectRuntimeSnapshot: vi.fn(),
    createScopedLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    logInfo: vi.fn(),
    logError: vi.fn(),
    axiosPost: vi.fn(),
  };
});

vi.mock("axios", () => ({
  default: {
    post: mocks.axiosPost,
  },
}));

vi.mock("../../../lib/aws/asgCommands", () => ({
  terminateAndScaleDown: mocks.terminateAndScaleDown,
  terminateAndReplace: mocks.terminateAndReplace,
}));

vi.mock("../../../lib/aws/ec2Commands", () => ({
  waitForPublicIP: mocks.waitForPublicIP,
}));

vi.mock("../../../lib/vmAgent/client", () => ({
  startVmContainer: mocks.startVmContainer,
  waitForRuntimeReady: mocks.waitForRuntimeReady,
  waitForVmAgentHealthy: mocks.waitForVmAgentHealthy,
}));

vi.mock("../../../services/asgManager", () => ({
  getIdleMachines: mocks.getIdleMachines,
  ensureIdleCapacityForAllocation: mocks.ensureIdleCapacityForAllocation,
}));

vi.mock("../../../services/redisManager", () => ({
  deleteInstanceLifecycle: mocks.deleteInstanceLifecycle,
  cleanupProjectRuntimeAssignment: mocks.cleanupProjectRuntimeAssignment,
  rehydrateProjectRuntimeRedis: mocks.rehydrateProjectRuntimeRedis,
  mirrorProjectAssignmentToRedis: mocks.mirrorProjectAssignmentToRedis,
}));

vi.mock("db/client", () => ({
  prisma: mocks.prisma,
}));

vi.mock("../../../services/projectLifecycleManager", () => ({
  markProjectBooting: mocks.markProjectBooting,
  markProjectFailed: mocks.markProjectFailed,
  markProjectReady: mocks.markProjectReady,
}));

vi.mock("../../../services/projectRuntimeTruthSource", () => ({
  ACTIVE_RUNTIME_STATUSES: ["ALLOCATING_VM", "BOOTING_CONTAINER", "READY"],
  getProjectRuntimeSnapshot: mocks.getProjectRuntimeSnapshot,
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  createScopedLogger: mocks.createScopedLogger,
  logInfo: mocks.logInfo,
  logError: mocks.logError,
}));

import {
  allocateVmAndScaleUp,
  ensureProjectRuntime,
} from "../../../services/ec2Manager";

describe("ec2Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mocks.prisma.projectRoom.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.project.findFirst.mockResolvedValue(null);
    mocks.prisma.project.findUnique.mockResolvedValue(null);

    mocks.waitForPublicIP.mockResolvedValue("1.2.3.4");
    mocks.waitForVmAgentHealthy.mockResolvedValue(undefined);
    mocks.startVmContainer.mockResolvedValue({
      containerName: "spinup-project_123",
    });
    mocks.waitForRuntimeReady.mockResolvedValue({
      source: "container_status",
      lastContainerStatus: { status: "running" },
    });
    mocks.markProjectBooting.mockResolvedValue({});
    mocks.markProjectReady.mockResolvedValue({});
    mocks.markProjectFailed.mockResolvedValue({});
    mocks.rehydrateProjectRuntimeRedis.mockResolvedValue(true);
    mocks.mirrorProjectAssignmentToRedis.mockResolvedValue({});
    mocks.cleanupProjectRuntimeAssignment.mockResolvedValue("runtime cleaned");
  });

  describe("allocateVmAndScaleUp", () => {
    it("returns an idle machine immediately when one already exists", async () => {
      mocks.getIdleMachines.mockResolvedValue([
        {
          InstanceId: "i-idle-1",
        },
      ]);

      const result = await allocateVmAndScaleUp();

      expect(result).toEqual({ instanceId: "i-idle-1" });
      expect(mocks.ensureIdleCapacityForAllocation).not.toHaveBeenCalled();
    });

    it("waits for scale-up and returns an instance when idle capacity appears", async () => {
      vi.useFakeTimers();

      mocks.getIdleMachines
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            InstanceId: "i-idle-2",
          },
        ]);

      mocks.ensureIdleCapacityForAllocation.mockResolvedValue({
        action: "SCALE_UP",
        targetDesiredCapacity: 2,
        reason: "Idle count below minimum",
      });

      const promise = allocateVmAndScaleUp();

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await promise;

      expect(mocks.ensureIdleCapacityForAllocation).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ instanceId: "i-idle-2" });
    });
  });

  describe("ensureProjectRuntime", () => {
    it("rehydrates Redis and returns the existing runtime when DB already has a READY assignment", async () => {
      const readyProject = makeProject({
        id: "project_123",
        ownerId: "user_123",
        name: "SpinUp Demo",
        type: "NEXTJS",
        status: "READY",
        assignedInstanceId: "i-ready",
        publicIp: "1.2.3.4",
        containerName: "spinup-project_123",
      });

      mocks.getProjectRuntimeSnapshot.mockResolvedValue({
        project: readyProject,
        runtime: null,
      });

      const result = await ensureProjectRuntime(
        "project_123",
        "SpinUp Demo",
        "NEXTJS",
        "user_123",
      );

      expect(mocks.rehydrateProjectRuntimeRedis).toHaveBeenCalledWith(
        "project_123",
      );
      expect(result).toEqual(
        makeRuntimeAssignment({
          userId: "user_123",
          instanceId: "i-ready",
          publicIP: "1.2.3.4",
          projectId: "project_123",
          projectName: "SpinUp Demo",
          projectType: "NEXTJS",
          containerName: "spinup-project_123",
        }),
      );
      expect(mocks.getIdleMachines).not.toHaveBeenCalled();
    });

    it("marks the project failed when no idle machine becomes available within timeout", async () => {
      vi.useFakeTimers();

      mocks.getProjectRuntimeSnapshot.mockResolvedValue({
        project: makeProject({
          id: "project_123",
          ownerId: "user_123",
          status: "CREATED",
        }),
        runtime: null,
      });

      mocks.getIdleMachines.mockResolvedValue([]);
      mocks.ensureIdleCapacityForAllocation.mockResolvedValue({
        action: "KEEP",
        reason: "No capacity available yet",
      });

      const promise = ensureProjectRuntime(
        "project_123",
        "SpinUp Demo",
        "NEXTJS",
        "user_123",
      );

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(185_000);

      const result = await promise;

      expect(result).toBeNull();
      expect(mocks.markProjectFailed).toHaveBeenCalledWith(
        "project_123",
        "No idle machine available within wait timeout",
      );
    });

    it("marks the project failed when public IP resolution fails", async () => {
      mocks.getProjectRuntimeSnapshot.mockResolvedValue({
        project: makeProject({
          id: "project_123",
          ownerId: "user_123",
          status: "CREATED",
        }),
        runtime: null,
      });

      mocks.getIdleMachines.mockResolvedValue([
        {
          InstanceId: "i-123",
        },
      ]);
      mocks.waitForPublicIP.mockResolvedValue("");

      const result = await ensureProjectRuntime(
        "project_123",
        "SpinUp Demo",
        "NEXTJS",
        "user_123",
      );

      expect(result).toBeNull();
      expect(mocks.terminateAndReplace).toHaveBeenCalledWith("i-123");
      expect(mocks.deleteInstanceLifecycle).toHaveBeenCalledWith("i-123");
      expect(mocks.markProjectFailed).toHaveBeenCalled();
    });

    it("marks the project failed when the VM agent never becomes healthy", async () => {
      mocks.getProjectRuntimeSnapshot.mockResolvedValue({
        project: makeProject({
          id: "project_123",
          ownerId: "user_123",
          status: "CREATED",
        }),
        runtime: null,
      });

      mocks.getIdleMachines.mockResolvedValue([
        {
          InstanceId: "i-123",
        },
      ]);
      mocks.waitForPublicIP.mockResolvedValue("1.2.3.4");
      mocks.waitForVmAgentHealthy.mockRejectedValue(
        new Error("VM agent health wait failed"),
      );

      const result = await ensureProjectRuntime(
        "project_123",
        "SpinUp Demo",
        "NEXTJS",
        "user_123",
      );

      expect(result).toBeNull();
      expect(mocks.terminateAndReplace).toHaveBeenCalledWith("i-123");
      expect(mocks.markProjectFailed).toHaveBeenCalled();
    });

    it("cleans up the previous active runtime for the same user before starting a new one", async () => {
      mocks.getProjectRuntimeSnapshot.mockResolvedValue({
        project: makeProject({
          id: "project_123",
          ownerId: "user_123",
          status: "CREATED",
        }),
        runtime: null,
      });

      mocks.prisma.project.findFirst.mockResolvedValue({
        id: "project_old",
      });

      mocks.getIdleMachines.mockResolvedValue([
        {
          InstanceId: "i-123",
        },
      ]);

      const result = await ensureProjectRuntime(
        "project_123",
        "SpinUp Demo",
        "NEXTJS",
        "user_123",
      );

      expect(mocks.cleanupProjectRuntimeAssignment).toHaveBeenCalledWith(
        "project_old",
        "user_123",
        expect.objectContaining({
          mode: "REASSIGN",
        }),
      );
      expect(result?.instanceId).toBe("i-123");
    });

    it("cancels provisioning safely when deletion wins during boot", async () => {
      mocks.getProjectRuntimeSnapshot.mockResolvedValue({
        project: makeProject({
          id: "project_123",
          ownerId: "user_123",
          status: "CREATED",
        }),
        runtime: null,
      });

      mocks.getIdleMachines.mockResolvedValue([
        {
          InstanceId: "i-123",
        },
      ]);

      mocks.prisma.project.findUnique.mockResolvedValue({
        id: "project_123",
        ownerId: "user_123",
        name: "SpinUp Demo",
        type: "NEXTJS",
        status: "DELETING",
        assignedInstanceId: null,
        publicIp: null,
        containerName: null,
      });

      const result = await ensureProjectRuntime(
        "project_123",
        "SpinUp Demo",
        "NEXTJS",
        "user_123",
      );

      expect(result).toBeNull();
      expect(mocks.terminateAndScaleDown).toHaveBeenCalledWith("i-123", false);
      expect(mocks.deleteInstanceLifecycle).toHaveBeenCalledWith("i-123");
      expect(mocks.markProjectBooting).not.toHaveBeenCalled();
      expect(mocks.markProjectReady).not.toHaveBeenCalled();
    });
  });
});