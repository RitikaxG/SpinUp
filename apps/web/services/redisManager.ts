import Redis from "ioredis";
import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import axios from "axios";
import { deleteS3Object } from "../lib/aws/s3Commands";
import { prisma } from "db/client";
import { markProjectDeleted, markProjectDeletePendingReason, markProjectDeleting } from "./projectLifecycleManager";
import { randomUUID } from "crypto";
import { clearProjectAssignmentSnapshot, getProjectRuntimeSnapshot } from "./projectRuntimeTruthSource";
import { logError, logInfo, logWarn } from "../lib/observability/structuredLogger";
import { ENV } from "../lib/config/env";

const REDIS_URL = ENV.REDIS_URL;

if(!REDIS_URL){
    console.error("REDIS_URL required");
}

export const redis = new Redis(REDIS_URL);

/*

only delete the key if the stored token matches the caller’s token
prevents one request from releasing another request’s lock
*/

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// returns token if lock acquired, returns null if lock already held

export const acquireDistributedLock = async (
    key : string,
    ttlMs : number,
): Promise<string | null> => {
    const token = randomUUID();
    const result = await redis.set(key,token,"PX",ttlMs,"NX");

    if(result != "OK"){
        return null;
    }

    return token;
}

export const releaseDistributedLock = async (
    key : string,
    token : string
): Promise<void> => {
    await redis.eval(RELEASE_LOCK_SCRIPT,1,key,token);
}

export const withDistributedLock = async<T>(
    key : string,
    ttlMs : number,
    fn : () => Promise<T>
) : Promise<T | null> => {
    const token = await acquireDistributedLock(key,ttlMs);
    if(!token){
        return null;
    }

    try{
        return await fn();
    } finally {
        await releaseDistributedLock(key,token)
    }
}

// Defining types and Key builders
export type InstanceStatus = "BOOTING" | "RUNNING" | "FAILED" | "TERMINATING" | "STOPPED" | "IDLE"

export type ProjectTypeValue = "NEXTJS" | "REACT" | "REACT_NATIVE"

export type InstanceRecord = {
    instanceId : string,
    userId : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue | "",
    publicIP : string,
    containerName : string,
    inUse : "true" | "false",
    allocatedAt : string,
    lastHeartbeatAt : string,
    lastHealthCheckAt : string,
    lastHealthError : string,
    heartbeatFailures : string,
    status : InstanceStatus
}

export const redisKeys = {
    instance : (instanceId : string) => `instance:${instanceId}`,
    userInstance: (userId : string) => `user:${userId}:instance`,
    projectInstance: (projectId : string) => `project:${projectId}:instance`,
    activeAssignedInstances : "instances:active" ,
}

export const controlPlaneLockKeys = {
    createProject : (ownerId : string, normalizedName: string ) => 
        `lock:project:create:${ownerId}:${normalizedName.toLowerCase()}`,
    deleteProject: (projectId : string ) => `lock:project:delete:${projectId}`,
    runtime : (projectId : string) => `lock:project:runtime:${projectId}`,
    tick: () => `lock:control-plane:tick`,
} as const;

export const CONTROL_PLANE_LOCK_TTL_MS = 30_000;

export const controlPlaneRedisKeys = {
  workerHeartbeat: "control-plane:worker:heartbeat",
} as const;

export type ControlPlaneWorkerHeartbeatStatus =
  | "STARTED"
  | "SUCCESS"
  | "FAILED";

export type ControlPlaneWorkerHeartbeatRecord = {
  lastSeenAt: string;
  updatedAt: string;
  status: ControlPlaneWorkerHeartbeatStatus;
  pid: string;
  hostname: string;
  lastResult: string;
  lastError: string;
};

const toControlPlaneWorkerHeartbeatRecord = (
  data: Record<string, string>,
): ControlPlaneWorkerHeartbeatRecord => {
  return {
    lastSeenAt: data.lastSeenAt ?? "",
    updatedAt: data.updatedAt ?? "",
    status: (data.status as ControlPlaneWorkerHeartbeatStatus) ?? "FAILED",
    pid: data.pid ?? "",
    hostname: data.hostname ?? "",
    lastResult: data.lastResult ?? "",
    lastError: data.lastError ?? "",
  };
};

const serializeHeartbeatResult = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable-result]";
  }
};

export const writeControlPlaneWorkerHeartbeat = async ({
  status,
  lastResult,
  lastError,
}: {
  status: ControlPlaneWorkerHeartbeatStatus;
  lastResult?: unknown;
  lastError?: string | null;
}) => {
  const now = new Date().toISOString();

  const record: ControlPlaneWorkerHeartbeatRecord = {
    lastSeenAt: now,
    updatedAt: now,
    status,
    pid: String(process.pid),
    hostname: process.env.HOSTNAME ?? "unknown",
    lastResult: serializeHeartbeatResult(lastResult),
    lastError: lastError ?? "",
  };

  await redis.hset(controlPlaneRedisKeys.workerHeartbeat, record);
  return record;
};

export const readControlPlaneWorkerHeartbeat = async (): Promise<ControlPlaneWorkerHeartbeatRecord | null> => {
  const data = await redis.hgetall(controlPlaneRedisKeys.workerHeartbeat);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return toControlPlaneWorkerHeartbeatRecord(data);
};

const toInstanceRecord = (data: Record<string,string>): InstanceRecord => {
    return {
        instanceId: data.instanceId ?? "",
        userId: data.userId ?? "",
        projectId : data.projectId ?? "",
        projectName : data.projectName ?? "",
        projectType: (data.projectType as ProjectTypeValue) ?? "",
        publicIP: data.publicIP ?? "",
        containerName: data.containerName ?? "",
        inUse: data.inUse === "true" ? "true" : "false",
        allocatedAt: data.allocatedAt ?? "",
        lastHeartbeatAt: data.lastHeartbeatAt ?? "",
        lastHealthCheckAt : data.lastHealthCheckAt ?? "",
        lastHealthError : data.lastHealthError ?? "",
        heartbeatFailures : data.heartbeatFailures ?? "0",
        status : (data.status as InstanceStatus) ?? "FAILED"
    }
}

// Read helper functions
export const getInstance = async ( instanceId : string) : Promise<InstanceRecord | null> => {
    const data = await redis.hgetall(redisKeys.instance(instanceId));
    if(!data || Object.keys(data).length === 0){
        return null;
    }

    return toInstanceRecord(data);
}

export const getInstanceIdForUser = async (userId : string) : Promise<string | null> => {
    const instanceId = await redis.get(redisKeys.userInstance(userId));
    return instanceId || null;
}

export const getInstanceIdForProject = async (projectId : string) : Promise<string | null> => {
    const instanceId = await redis.get(redisKeys.projectInstance(projectId));
    return instanceId || null;
}

// an object is passed to this function as input, we destructure the object arguement
export const writeBootingInstance = async ({
    instanceId,
    userId,
    projectId,
    projectName,
    projectType,
    publicIP
}:{
    instanceId : string,
    userId : string,
    projectId : string,
    projectName : string,
    projectType: ProjectTypeValue,
    publicIP : string,
}) => {
    const now = Date.now().toString();

    // Build instance record
    const record : InstanceRecord = {
        instanceId,
        userId,
        projectId,
        projectName,
        projectType,
        publicIP,
        containerName: "",
        inUse: "true",
        allocatedAt: now,
        lastHeartbeatAt: now,
        lastHealthCheckAt : now,
        lastHealthError : "",
        heartbeatFailures : "0",
        status: "BOOTING"
    };

    await redis.multi()
        .hset(redisKeys.instance(instanceId),record) // full instance metadata
        .set(redisKeys.userInstance(userId),instanceId) // user-instance mapping
        .set(redisKeys.projectInstance(projectId),instanceId) // project-instance mapping
        .sadd(redisKeys.activeAssignedInstances,instanceId)
        .exec();

    logInfo({
        projectId,
        userId,
        instanceId,
        operation: "runtime.redis_assignment.written",
        status: "SUCCESS",
        reason: "Booting runtime assignment mirrored to Redis",
        meta: {
            publicIP,
            projectType,
            redisStatus: "BOOTING",
        },
    });

    return record;
}

export const writeRunningInstance = async({
    instanceId,
    userId,
    projectId,
    projectName,
    projectType,
    publicIP,
    containerName
}:{
    instanceId : string,
    userId : string,
    projectId : string,
    projectName: string,
    projectType : ProjectTypeValue,
    publicIP : string,
    containerName : string
})  => {
    const now = Date.now().toString();

    const record : InstanceRecord = {
        instanceId,
        userId,
        projectId,
        projectName,
        projectType,
        publicIP,
        containerName,
        inUse: "true",
        allocatedAt: now,
        lastHeartbeatAt: now,
        lastHealthCheckAt : now,
        lastHealthError : "",
        heartbeatFailures : "0",
        status: "RUNNING"
    };

    await redis.multi()
        .hset(redisKeys.instance(instanceId),record)
        .set(redisKeys.userInstance(userId),instanceId)
        .set(redisKeys.projectInstance(projectId),instanceId)
        .sadd(redisKeys.activeAssignedInstances,instanceId)
        .exec()

    logInfo({
        projectId,
        userId,
        instanceId,
        containerName,
        operation: "runtime.redis_assignment.written",
        status: "SUCCESS",
        reason: "Running runtime assignment mirrored to Redis",
        meta: {
            publicIP,
            projectType,
            redisStatus: "RUNNING",
        },
    });

    return record;
}

export const mirrorProjectAssignmentToRedis = async({
    instanceId,
    userId,
    projectId,
    projectName,
    projectType,
    publicIP,
    containerName,
    status,
}:{
    instanceId : string,
    userId : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue,
    publicIP : string,
    containerName : string,
    status : "BOOTING" | "RUNNING",
}) => {
    if(status === "BOOTING"){
        return writeBootingInstance({
            instanceId,
            userId,
            projectId,
            projectName,
            projectType,
            publicIP,
        });
    }

    return writeRunningInstance({
        instanceId,
        userId,
        projectId,
        projectName,
        projectType,
        publicIP,
        containerName,
    })
};

export const rehydrateProjectRuntimeRedis = async(projectId : string) => {
    const snapshot = await getProjectRuntimeSnapshot(projectId);

    if(!snapshot.project){
        return null;
    };

    const project = snapshot.project;

    if(!project.assignedInstanceId || !project.publicIp
        || (project.status !== "BOOTING_CONTAINER" && project.status !== "READY")
    ){
        return null;
    }

    const containerName = project.containerName ?? "";

    await mirrorProjectAssignmentToRedis({
        instanceId : project.assignedInstanceId,
        userId : project.ownerId,
        projectId : project.id,
        projectName : project.name,
        projectType : project.type,
        publicIP : project.publicIp,
        containerName,
        status : project.status === "READY" ? "RUNNING" : "BOOTING",
    });

    return true;
}

export const writeIdleInstance = async (instanceId : string) => {
    const existing = await getInstance(instanceId);
    if(!existing){
        throw new Error(`No instance metadata found for ${instanceId}`);
    }

    const now = Date.now().toString();
    const idleRecord : InstanceRecord = {
        instanceId,
        userId: "",
        projectId: "",
        projectName: "",
        projectType: "",
        publicIP: existing.publicIP,
        containerName: "",
        inUse: "false",
        allocatedAt: "",
        lastHeartbeatAt: now,
        lastHealthCheckAt : now,
        lastHealthError :"",
        heartbeatFailures : "0",
        status: "IDLE"
    }

    await redis.multi()
        .del(redisKeys.userInstance(existing.userId))
        .del(redisKeys.projectInstance(existing.projectId))
        .hset(redisKeys.instance(instanceId),idleRecord)
        .srem(redisKeys.activeAssignedInstances,instanceId)
        .exec()

    logInfo({
        instanceId,
        operation: "instance.returned_idle",
        status: "SUCCESS",
        reason: "Healthy instance returned to idle pool",
        meta: {
            publicIP: existing.publicIP,
        },
    });

    return idleRecord;
}

export const markInstanceTerminating = async(instanceId : string) => {
    const existing = await getInstance(instanceId);
    if(!existing){
        return null;
    }

    const now = Date.now().toString();

    const terminatingRecord: InstanceRecord = {
        ...existing,
        lastHeartbeatAt: now,
        status : "TERMINATING"
    }

    await redis.hset(redisKeys.instance(instanceId),terminatingRecord);
    return terminatingRecord;
}

export const updateInstanceHeartbeat = async(instanceId : string) => {
    const existing = await getInstance(instanceId);
    if(!existing){
        return null;
    }

    const now = Date.now().toString();
    const updated : InstanceRecord = {
        ...existing,
        lastHeartbeatAt: now
    }

    await redis.hset(redisKeys.instance(instanceId),updated);
}

// Delete helper function
export const deleteInstanceMappings = async (record : {
    userId? : string,
    projectId? : string,
}) => {
    const multi = redis.multi();

    if(record.userId){
        multi.del(redisKeys.userInstance(record.userId));
    }

    if(record.projectId){
        multi.del(redisKeys.projectInstance(record.projectId));
    }

    await multi.exec();
}

export const deleteInstanceRecord = async (instanceId : string) => {
    await redis
        .multi()
        .del(redisKeys.instance(instanceId))
        .srem(redisKeys.activeAssignedInstances, instanceId)
        .exec();
}

// Combined Cleanup
export const deleteInstanceLifecycle = async (instanceId : string) => {
    const existing = await getInstance(instanceId);

    if(!existing){
        await deleteInstanceRecord(instanceId);
        return;
    }

    await redis.multi()
        .del(redisKeys.instance(instanceId))
        .del(redisKeys.userInstance(existing.userId))
        .del(redisKeys.projectInstance(existing.projectId))
        .srem(redisKeys.activeAssignedInstances,instanceId)
        .exec()
}

const bestEffortTerminateInstance = async(
    instanceId : string,
    shouldDecreaseCapacity : boolean,
) => {
    try{
        await terminateAndScaleDown(instanceId, shouldDecreaseCapacity);

        logInfo({
            instanceId,
            operation: "instance.terminated",
            status: "SUCCESS",
            reason: shouldDecreaseCapacity
                ? "Instance terminated and desired capacity decremented"
                : "Instance terminated without decreasing desired capacity",
            meta: {
                shouldDecreaseCapacity,
            },
        });
    } catch(err){
        logError({
            instanceId,
            operation: "instance.terminated",
            status: "FAILED",
            reason: err instanceof Error ? err.message : "Terminate failed",
            meta: {
                shouldDecreaseCapacity,
            },
        });

    } finally {
        await deleteInstanceLifecycle(instanceId);
    }
}

export const cleanupProjectArtifacts = async ({
    projectId,
    projectName,
    projectType,
}: {
    projectId : string,
    projectName : string,
    projectType : string
}) => {
    const objectKey = `projects/${projectName}_${projectId}/code-${projectType}`;

    // S3 delete is idempotent: deleting a missing object still succeeds.
    await deleteS3Object("bolt-app-v1",objectKey);

    return `Deleted S3 object if present ${objectKey}`;

}

export const finalizeProjectDeletion = async (
    projectId : string,
    ownerId : string
) => {
    const project = await prisma.project.findFirst({
        where : { id : projectId, ownerId },
        select : {
            id : true,
            status : true,
            assignedInstanceId : true,
            publicIp : true,
            containerName : true,
        }
    });

    if(!project){
        throw new Error("Project not found or user does not own the project.")
    }

    if(project.status !== "DELETING"){
        await markProjectDeletePendingReason(
            projectId,
            `Deletion not finalised: project status is ${project.status}, expected DELETING`,
        )
        return null;
    }
    
    if(
        project.assignedInstanceId || project.publicIp || project.containerName
    ){
        await markProjectDeletePendingReason(
            projectId,
            "Deletion not finalised: DB still shows active runtime assignment",
        )

        logWarn({
            projectId,
            userId: ownerId,
            instanceId: project.assignedInstanceId,
            containerName: project.containerName,
            operation: "project.deletion.finalize_skipped",
            status: "SKIPPED",
            reason: "Deletion not finalised because runtime assignment still present or status not DELETING",
            meta: {
                currentStatus: project.status,
                publicIP: project.publicIp,
            },
        });
        return null;
    }

    await prisma.projectRoom.updateMany({
        where: {
            projectId,
            userId : ownerId,
        },
        data : {
            vmState : "STOPPED"
        }
    });

    const deletedProject = await markProjectDeleted(projectId, {
        cleanupCompletedAt: new Date(),
    });

    logInfo({
        projectId,
        userId: ownerId,
        operation: "project.deletion.finalized",
        status: "SUCCESS",
        reason: "Project marked DELETED",
        meta: {},
    });

    return deletedProject;
}

export const cleanUpOwnedProjectInstance = async (projectId : string, ownerId : string) => {
   
    // 1. Ownership Verification
    const ownedProject = await prisma.project.findFirst({
        where : {
            id : projectId,
            ownerId,
        },
        select: {
            id : true,
            name : true,
            type : true,
        }
    })

    if(!ownedProject){
        throw new Error("Forbidden cleanup attempt : User does not own the project");
    }

    await markProjectDeleting(projectId);

    try{
        const runtimeCleanupMessage = await cleanupProjectRuntimeAssignment(projectId, ownerId);

        const artifactCleanupMessage = await cleanupProjectArtifacts({
            projectId,
            projectName : ownedProject.name,
            projectType : ownedProject.type,
        });

        const finalized = await finalizeProjectDeletion(projectId, ownerId);

        if(!finalized){
            return `Deletion still reconciling. ${runtimeCleanupMessage}. ${artifactCleanupMessage}`
        }

        return `Project ${projectId} deleted successfully. ${runtimeCleanupMessage}. ${artifactCleanupMessage}.`
    } catch(err : unknown){
       await markProjectDeletePendingReason(projectId,
        err instanceof Error ? err.message : "Unknown delete cleanup error"
       );

       logError({
            projectId,
            userId: ownerId,
            operation: "runtime.cleanup.failed",
            status: "FAILED",
            reason: err instanceof Error ? err.message : "Unknown delete cleanup error",
            meta: {},
        });

       throw err;
    }
}

const pingVmAgent = async(publicIP : string) => {
    try{
        const healthCheck = await axios.get(`http://${publicIP}:3000/health`,{
            timeout: 5000
        });

        return healthCheck.data === "OK";
    }catch{
        return false;
    }
}

const buildDeterministicContainerName = (projectId: string) => `spinup-${projectId}`;

const resolveContainerNameForStop = (instanceMetaData: InstanceRecord) => {
  if (instanceMetaData.containerName) {
    return instanceMetaData.containerName;
  }

  if (instanceMetaData.projectId) {
    return buildDeterministicContainerName(instanceMetaData.projectId);
  }

  return "";
};

const recycleInstanceIfHealthy = async(instanceMetaData : InstanceRecord) => {
    const containerNameToStop = resolveContainerNameForStop(instanceMetaData);
    let stopSuceeded = false;

    if(instanceMetaData.publicIP && containerNameToStop){
        
        try{
            await axios.post(`http://${instanceMetaData.publicIP}:3000/stop`,{
                containerName : containerNameToStop,
            },{
                timeout: 5000
            })
            stopSuceeded = true;
        }catch(err){
            if(err instanceof Error){
                console.error(`Failed to stop container for instance ${instanceMetaData.instanceId}: ${err.message}`);
            }
        }
    }

    const vmHealthy = instanceMetaData.publicIP ? await pingVmAgent(instanceMetaData.publicIP) : false;

    // Only recycle if we positively stopped the container and the VM is healthy.
    if(stopSuceeded && vmHealthy){
        await writeIdleInstance(instanceMetaData.instanceId);
        return {
            disposition : "IDLE" as const,
            message : `Returned healthy instance ${instanceMetaData.instanceId} to idle pool`
        }
    }

    await markInstanceTerminating(instanceMetaData.instanceId);
    await bestEffortTerminateInstance(instanceMetaData.instanceId, false);

    return {
        disposition : "TERMINATED" as const,
        message : `Terminated unhealthy instance ${instanceMetaData.instanceId} instead of recycling it.`
    }
}



export const cleanupProjectRuntimeAssignment = async (
  projectId: string,
  ownerId: string,
) => {

  logInfo({
      projectId,
      userId: ownerId,
      operation: "runtime.cleanup.started",
      status: "STARTED",
      reason: null,
      meta: {},
  });

  const ownedProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      ownerId,
    },
    select: {
      id: true,
      ownerId: true,
      name : true,
      type : true,
      assignedInstanceId : true,
      publicIp : true,
      containerName : true,
    },
  });

  if (!ownedProject) {
    throw new Error("Forbidden cleanup attempt: user does not own the project");
  }

  await prisma.projectRoom.updateMany({
    where: {
      projectId,
      userId: ownerId,
    },
    data: {
      vmState: "TERMINATING",
    },
  });

  const instanceId = ownedProject.assignedInstanceId;

  if (!instanceId) {
    await deleteInstanceMappings({
      userId: ownerId,
      projectId,
    });

    await clearProjectAssignmentSnapshot(projectId);

    await prisma.projectRoom.updateMany({
      where: {
        projectId,
        userId: ownerId,
      },
      data: {
        vmState: "STOPPED",
      },
    });

    logInfo({
        projectId,
        userId: ownerId,
        operation: "runtime.cleanup.completed",
        status: "SUCCESS",
        reason: "No active instance for project",
        meta: {},
    });

    return `No active instance for project ${projectId}`;
  }

  const rediseMetaData = await getInstance(instanceId);

  const instanceMetaData : InstanceRecord = rediseMetaData ?? {
    instanceId,
    userId : ownerId,
    projectId,
    projectName : ownedProject.name,
    projectType : ownedProject.type,
    publicIP : ownedProject.publicIp ?? "",
    containerName : ownedProject.containerName ?? "",
    inUse : "true",
    allocatedAt : "",
    lastHeartbeatAt : "",
    lastHealthCheckAt : "",
    lastHealthError : "",
    heartbeatFailures : "0",
    status: "RUNNING"
  }

  const result = await recycleInstanceIfHealthy(instanceMetaData);

  await clearProjectAssignmentSnapshot(projectId);

  await deleteInstanceMappings({
    userId : ownerId,
    projectId,
  })

  await prisma.projectRoom.updateMany({
    where: {
      projectId,
      userId: ownerId,
    },
    data: {
      vmState: "STOPPED",
    },
  });

  logInfo({
        projectId,
        userId: ownerId,
        instanceId,
        containerName: instanceMetaData.containerName,
        operation: "runtime.cleanup.completed",
        status: "SUCCESS",
        reason: result.message,
        meta: {
            disposition: result.disposition,
            publicIP: instanceMetaData.publicIP,
        },
    });

  return `${instanceId} associated with ${projectId} successfully cleaned up. ${result.message}`;
};

export const incrementHeartbeatFailure = async (
    instanceId : string,
    error : string,
) : Promise<number | null> => {

    const existing = await getInstance(instanceId);
    if(!existing) return null;

    const nextFailures = Number(existing.heartbeatFailures ?? "0") + 1;
    const now = Date.now().toString();

    const updated : InstanceRecord = {
        ...existing,
        heartbeatFailures : nextFailures.toString(),
        lastHealthCheckAt : now,
        lastHealthError : error,
    }

    await redis.hset(redisKeys.instance(instanceId),updated);
    return nextFailures;
    
}

export const listActiveAssignedInstanceIds = async() : Promise<string[]> => {
    return redis.smembers(redisKeys.activeAssignedInstances)
}

export const resetHeartbeatFailure = async ( instanceId : string ) => {
    const existing = await getInstance(instanceId);
    if(!existing) return null;

    const now = Date.now().toString();

    const updated : InstanceRecord = {
        ...existing,
        lastHealthCheckAt : now,
        lastHealthError : "",
        heartbeatFailures : "0",
    };

    await redis.hset(redisKeys.instance(instanceId),updated);
    return updated;
}