
type ProjectTypeValue = "NEXTJS" | "REACT" | "REACT_NATIVE";

type ProjectStatusValue =
  | "CREATED"
  | "ALLOCATING_VM"
  | "BOOTING_CONTAINER"
  | "READY"
  | "FAILED"
  | "DELETING"
  | "DELETED";

type InstanceStatus =
  | "BOOTING"
  | "RUNNING"
  | "FAILED"
  | "TERMINATING"
  | "STOPPED"
  | "IDLE";

export const makeDBUser = (
    overrides: Partial<{
        id : string;
        clerkId : string;
        email : string;
    }> = {},
 ) => {
    return {
        id: "user_123",
        clerkId: "clerk_123",
        email: "ritika@example.com",
        ...overrides,
    }
}

export const makeProject = (
  overrides: Partial<{
    id: string;
    ownerId: string;
    name: string;
    type: ProjectTypeValue;
    status: ProjectStatusValue;
    assignedInstanceId: string | null;
    publicIp: string | null;
    containerName: string | null;
    deletedAt: Date | null;
  }> = {},
) => {
  return {
    id: "project_123",
    ownerId: "user_123",
    name: "SpinUp Demo",
    type: "NEXTJS" as ProjectTypeValue,
    status: "CREATED" as ProjectStatusValue,
    assignedInstanceId: null,
    publicIp: null,
    containerName: null,
    deletedAt: null,
    ...overrides,
  };
};

export const makeRuntimeAssignment = (
  overrides: Partial<{
    userId: string;
    instanceId: string;
    publicIP: string;
    projectId: string;
    projectName: string;
    projectType: ProjectTypeValue;
    containerName: string;
  }> = {},
) => {
  return {
    userId: "user_123",
    instanceId: "i-123",
    publicIP: "1.2.3.4",
    projectId: "project_123",
    projectName: "SpinUp Demo",
    projectType: "NEXTJS" as ProjectTypeValue,
    containerName: "spinup-project_123",
    ...overrides,
  };
};

export const makeInstanceRecord = (
  overrides: Partial<{
    instanceId: string;
    userId: string;
    projectId: string;
    projectName: string;
    projectType: ProjectTypeValue;
    publicIP: string;
    containerName: string;
    inUse: "true" | "false";
    allocatedAt: string;
    lastHeartbeatAt: string;
    lastHealthCheckAt: string;
    lastHealthError: string;
    heartbeatFailures: string;
    status: InstanceStatus;
  }> = {},
) => {
  return {
    instanceId: "i-123",
    userId: "user_123",
    projectId: "project_123",
    projectName: "SpinUp Demo",
    projectType: "NEXTJS" as ProjectTypeValue,
    publicIP: "1.2.3.4",
    containerName: "spinup-project_123",
    inUse: "true" as const,
    allocatedAt: String(Date.now()),
    lastHeartbeatAt: String(Date.now()),
    lastHealthCheckAt: String(Date.now()),
    lastHealthError: "",
    heartbeatFailures: "0",
    status: "RUNNING" as InstanceStatus,
    ...overrides,
  };
};

export const makeCreateProjectBody = (
  overrides: Partial<{
    name: string;
    type: ProjectTypeValue;
  }> = {},
) => {
  return {
    name: "SpinUp Demo",
    type: "NEXTJS" as ProjectTypeValue,
    ...overrides,
  };
};