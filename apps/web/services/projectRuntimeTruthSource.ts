// DB-First Reader Layer

import { ProjectLifecycleStatus } from "db/client"

export type ActiveAssignmentSnapshot = {
    projectId : string,
    ownerId : string,
    projectName : string,
    projectType : "NEXTJS" | "REACT" | "REACT_NATIVE",
    status : ProjectLifecycleStatus,
    assignedInstanceId : string,
    publicIp : string | null,
    containerName : string | null,
    lastHeartbeatAt : Date | null,
};

export const ACTIVE_RUNTIME_STATUSES : ProjectLifecycleStatus[] = [
    "ALLOCATING_VM",
    "BOOTING_CONTAINER",
    "READY"
]