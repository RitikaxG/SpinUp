import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = {
  project: {
    findFirst: vi.fn(),
  },
};

vi.mock("db/client", () => ({
  prisma: mockPrisma,
}));

const buildProjectSnapshotMock = vi.fn();
const cleanupProjectRuntimeAssignmentMock = vi.fn();
const cleanupProjectArtifactsMock = vi.fn();
const finalizeProjectDeletionMock = vi.fn();
const withDistributedLockMock = vi.fn();
const logWarnMock = vi.fn();
const createScopedLoggerMock = vi.fn(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../services/projectRuntimeTruthSource", () => ({
  getProjectRuntimeSnapshot: buildProjectSnapshotMock,
}));

vi.mock("../../services/redisManager", () => ({
  withDistributedLock: withDistributedLockMock,
  controlPlaneLockKeys: {
    deleteProject: (projectId: string) => `lock:project:delete:${projectId}`,
    runtime: (projectId: string) => `lock:project:runtime:${projectId}`,
  },
  CONTROL_PLANE_LOCK_TTL_MS: 30000,
  cleanupProjectRuntimeAssignment: cleanupProjectRuntimeAssignmentMock,
  cleanupProjectArtifacts: cleanupProjectArtifactsMock,
  finalizeProjectDeletion: finalizeProjectDeletionMock,
}));

vi.mock("../../services/projectLifecycleManager", () => ({
  markProjectDeleting: vi.fn(),
  markProjectDeletePendingReason: vi.fn(),
  markProjectAllocating: vi.fn(),
}));

vi.mock("../../lib/observability/structuredLogger", () => ({
  createScopedLogger: createScopedLoggerMock,
  logWarn: logWarnMock,
}));

describe("deleteOrResumeProject - deleting resume path", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    withDistributedLockMock.mockImplementation(
      async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
    );
  });

  it("resumes cleanup when project is already DELETING", async () => {
    const deletingProject = {
      id: "project_123",
      ownerId: "user_123",
      name: "Delete During Boot",
      type: "NEXTJS",
      status: "DELETING",
    };

    mockPrisma.project.findFirst.mockResolvedValue(deletingProject);

    buildProjectSnapshotMock.mockResolvedValue({
      project: {
        ...deletingProject,
        assignedInstanceId: null,
        publicIp: null,
        containerName: null,
      },
      runtime: null,
    });

    cleanupProjectRuntimeAssignmentMock.mockResolvedValue("ok");
    cleanupProjectArtifactsMock.mockResolvedValue("ok");
    finalizeProjectDeletionMock.mockResolvedValue({ id: "project_123" });

    const { deleteOrResumeProject } = await import("../../services/projectControlPlane");

    const result = await deleteOrResumeProject({
      projectId: "project_123",
      ownerId: "user_123",
    });

    expect(cleanupProjectRuntimeAssignmentMock).toHaveBeenCalledWith(
      "project_123",
      "user_123",
    );
    expect(cleanupProjectArtifactsMock).toHaveBeenCalled();
    expect(finalizeProjectDeletionMock).toHaveBeenCalledWith(
      "project_123",
      "user_123",
    );

    expect(result.httpStatus).toBe(200);
    expect(result.inProgress).toBe(false);
  });
});