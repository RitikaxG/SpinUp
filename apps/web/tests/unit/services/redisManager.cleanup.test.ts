import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject } from "../../factories/project";

const mocks = vi.hoisted(() => {
  return {
    axiosPost: vi.fn(),
    axiosGet: vi.fn(),
    terminateAndScaleDown: vi.fn(),
    deleteS3Object: vi.fn(),
    prisma: {
      project: {
        findFirst: vi.fn(),
      },
      projectRoom: {
        updateMany: vi.fn(),
      },
    },
    markProjectDeleted: vi.fn(),
    markProjectDeletePendingReason: vi.fn(),
    markProjectDeleting: vi.fn(),
    clearProjectAssignmentSnapshot: vi.fn(),
    getProjectRuntimeSnapshot: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("axios", () => ({
  default: {
    post: mocks.axiosPost,
    get: mocks.axiosGet,
  },
}));

vi.mock("db/client", () => ({
  prisma: mocks.prisma,
}));

vi.mock("../../../lib/aws/asgCommands", () => ({
  terminateAndScaleDown: mocks.terminateAndScaleDown,
}));

vi.mock("../../../lib/aws/s3Commands", () => ({
  deleteS3Object: mocks.deleteS3Object,
}));

vi.mock("../../../services/projectLifecycleManager", () => ({
  markProjectDeleted: mocks.markProjectDeleted,
  markProjectDeletePendingReason: mocks.markProjectDeletePendingReason,
  markProjectDeleting: mocks.markProjectDeleting,
}));

vi.mock("../../../services/projectRuntimeTruthSource", () => ({
  clearProjectAssignmentSnapshot: mocks.clearProjectAssignmentSnapshot,
  getProjectRuntimeSnapshot: mocks.getProjectRuntimeSnapshot,
}));

vi.mock("../../../lib/observability/structuredLogger", () => ({
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

import {
  cleanupProjectRuntimeAssignment,
  getInstance,
  getInstanceIdForProject,
  getInstanceIdForUser,
  writeRunningInstance,
} from "../../../services/redisManager";

describe("redisManager cleanup paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearProjectAssignmentSnapshot.mockResolvedValue({});
    mocks.prisma.projectRoom.updateMany.mockResolvedValue({ count: 1 });
  });

  it("cleans up runtime when mappings exist and returns a healthy instance to idle", async () => {
    const project = makeProject({
      id: "project_123",
      ownerId: "user_123",
      name: "SpinUp Demo",
      type: "NEXTJS",
      assignedInstanceId: "i-123",
      publicIp: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    mocks.prisma.project.findFirst.mockResolvedValue(project);
    mocks.axiosPost.mockResolvedValue({ data: { ok: true } });
    mocks.axiosGet.mockResolvedValue({ data: "OK" });

    await writeRunningInstance({
      instanceId: "i-123",
      userId: "user_123",
      projectId: "project_123",
      projectName: "SpinUp Demo",
      projectType: "NEXTJS",
      publicIP: "1.2.3.4",
      containerName: "spinup-project_123",
    });

    const message = await cleanupProjectRuntimeAssignment(
      "project_123",
      "user_123",
    );

    const record = await getInstance("i-123");

    expect(record?.status).toBe("IDLE");
    expect(record?.inUse).toBe("false");
    expect(await getInstanceIdForProject("project_123")).toBeNull();
    expect(await getInstanceIdForUser("user_123")).toBeNull();
    expect(mocks.clearProjectAssignmentSnapshot).toHaveBeenCalledWith(
      "project_123",
    );
    expect(message).toContain("Returned healthy instance");
  });

  it("cleans up safely when project has no active assigned instance", async () => {
    const staleProject = makeProject({
      id: "project_999",
      ownerId: "user_123",
      name: "Old Demo",
      type: "NEXTJS",
      assignedInstanceId: null,
      publicIp: null,
      containerName: null,
    });

    mocks.prisma.project.findFirst.mockResolvedValue(staleProject);

    await writeRunningInstance({
      instanceId: "i-stale",
      userId: "user_123",
      projectId: "project_999",
      projectName: "Old Demo",
      projectType: "NEXTJS",
      publicIP: "9.9.9.9",
      containerName: "spinup-project_999",
    });

    const message = await cleanupProjectRuntimeAssignment(
      "project_999",
      "user_123",
    );

    expect(await getInstanceIdForProject("project_999")).toBeNull();
    expect(await getInstanceIdForUser("user_123")).toBeNull();
    expect(mocks.clearProjectAssignmentSnapshot).toHaveBeenCalledWith(
      "project_999",
    );
    expect(message).toContain("No active instance");
  });
});