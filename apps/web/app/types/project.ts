export type ProjectStatus =
  | "CREATED"
  | "ALLOCATING_VM"
  | "BOOTING_CONTAINER"
  | "READY"
  | "STOPPED"
  | "FAILED"
  | "DELETING"
  | "DELETED";

export type ProjectType = "NEXTJS" | "REACT" | "REACT_NATIVE";

export type Project = {
  id: string;
  name: string;
  type: ProjectType;

  status: ProjectStatus;
  statusReason?: string | null;

  assignedInstanceId?: string | null;
  publicIp?: string | null;
  containerName?: string | null;

  bootStartedAt?: string | null;
  bootCompletedAt?: string | null;
  lastHeartbeatAt?: string | null;

  lastEventType?: string | null;
  lastEventMessage?: string | null;
  lastEventAt?: string | null;

  createdAt?: string;
  updatedAt?: string;
};

export type ProjectApiResponse = {
  message: string;
  project?: Project | null;
  runtime?: unknown;
  inProgress?: boolean;
};

export type CreateProjectInput = {
  name: string;
  type: ProjectType;
};