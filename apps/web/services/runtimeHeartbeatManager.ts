import axios from "axios";
import { cleanupProjectRuntimeAssignment, controlPlaneLockKeys, deleteInstanceLifecycle, getInstance, incrementHeartbeatFailure, InstanceRecord, resetHeartbeatFailure, updateInstanceHeartbeat, withDistributedLock } from "./redisManager";
import { CONTAINER_STATUS_TIMEOUT_MS, HEALTH_TIMEOUT_MS, HEARTBEAT_FAILURE_THRESHOLD, PROJECT_RUNTIME_LOCK_TTL_MS } from "../lib/control-plane/config";
import { markProjectFailed, touchProjectHeartbeat } from "./projectLifecycleManager";
import { prisma } from "db/client";
import { appendProjectEvent, getAssignedProjectByInstanceId, listActiveProjectAssignments } from "./projectRuntimeTruthSource";
import { logError, logInfo, logWarn } from "../lib/observability/structuredLogger";

type HealthSeverity = "SOFT" | "HARD";

type HealthCheckResult = 
    | { healthy : true }
    | { healthy : false, severity : HealthSeverity, reason : string }

export type HeartbeatRunSummary = {
    scanned : number,
    healthy : number,
    softFailures : number,
    hardFailures : number,
    recovered : number,
    skipped : number,
    errors : number,
};

export const listActiveAssignedInstances = async (): Promise<InstanceRecord[]> => {
  const assignments = await listActiveProjectAssignments();

  const redisRecords = await Promise.all(
    assignments.map((assignment) => getInstance(assignment.assignedInstanceId)),
  );

  return assignments
    .map((assignment, index) => {
      const redisRecord = redisRecords[index];

      return {
        instanceId: assignment.assignedInstanceId,
        userId: assignment.ownerId,
        projectId: assignment.projectId,
        projectName: assignment.projectName,
        projectType: assignment.projectType,
        publicIP: assignment.publicIp ?? "",
        containerName: assignment.containerName ?? "",
        inUse: "true",
        allocatedAt: "",
        lastHeartbeatAt: String(
          redisRecord?.lastHeartbeatAt ??
            assignment.lastHeartbeatAt?.getTime() ??
            Date.now(),
        ),
        lastHealthCheckAt: redisRecord?.lastHealthCheckAt ?? "",
        lastHealthError: redisRecord?.lastHealthError ?? "",
        heartbeatFailures: redisRecord?.heartbeatFailures ?? "0",
        status: assignment.status === "READY" ? "RUNNING" : "BOOTING",
      } satisfies InstanceRecord;
    })
    .filter((record) => Boolean(record.publicIP));
};

export const checkRuntimeHealth = async(
    instance : InstanceRecord
) : Promise<HealthCheckResult> => {
    if(!instance.projectId || !instance.userId || !instance.publicIP){
        return {
            healthy : false,
            severity : "HARD",
            reason : "Missing required assigned runtime metadata"
        }
    }

    if(!instance.containerName){
        return {
            healthy : false,
            severity : "HARD",
            reason : "Missing assigned runtime container name"
        }
    };

    try{
        const containerStatus = await axios.post(
            `http://${instance.publicIP}:3000/containerStatus`,
            { containerName : instance.containerName },
            { timeout : CONTAINER_STATUS_TIMEOUT_MS },
        );

        const status = String(containerStatus.data.status ?? "").toLowerCase();
        
        if(status === "stopped"){
            return {
                healthy : false,
                severity : "HARD",
                reason : "Container is stopped"
            }
        }

        if(status && status != "running"){
            return {
                healthy : false,
                severity : "SOFT",
                reason : `Unexpected container status : ${status}`,
            }
        }
    } catch(err){
        return {
            healthy : false,
            severity : "SOFT",
            reason : 
                err instanceof Error 
                ? `Container status check failed : ${err.message}.`
                : `Container staus check failed.`
        }
    }

    try{
        const healthCheck = await axios.get(`http://${instance.publicIP}:3000/health`,{
            timeout : HEALTH_TIMEOUT_MS,
        });

        if(healthCheck.data !== "OK"){
            return {
                healthy : false,
                severity : "SOFT",
                reason : "Health endpoint returned non OK response"
            };
        }
    } catch(err) {
        return {
            healthy : false,
            severity : "SOFT",
            reason :
                err instanceof Error 
                ? `Health check failed : ${err.message}`
                : "Health check failed."
        }
    }

    return { healthy : true }
}

export const handleHeartbeatSuccess = async (instance : InstanceRecord) => {
    await updateInstanceHeartbeat(instance.instanceId);
    await resetHeartbeatFailure(instance.instanceId);
    await touchProjectHeartbeat(instance.projectId);

    logInfo({
        projectId: instance.projectId,
        userId: instance.userId,
        instanceId: instance.instanceId,
        containerName: instance.containerName,
        operation: "heartbeat.success",
        status: "SUCCESS",
        reason: null,
        meta: {
            publicIP: instance.publicIP,
        },
    });
};

export const recoverProjectRuntime = async(
    instance : InstanceRecord,
    reason : string,
) : Promise<boolean> => {
    logWarn({
        projectId: instance.projectId,
        userId: instance.userId,
        instanceId: instance.instanceId,
        containerName: instance.containerName,
        operation: "runtime.recovery.started",
        status: "STARTED",
        reason,
        meta: {
            publicIP: instance.publicIP,
        },
    });

    const recoveryResult = await withDistributedLock(
        controlPlaneLockKeys.runtime(instance.projectId),
        PROJECT_RUNTIME_LOCK_TTL_MS,
        async () => {
            const assignedProject = await getAssignedProjectByInstanceId(instance.instanceId);
             if (!assignedProject || assignedProject.id !== instance.projectId) {
                await deleteInstanceLifecycle(instance.instanceId);
                return false;
            }

            const project = await prisma.project.findUnique({
                where : { id : instance.projectId },
                select : { id : true, ownerId : true, status : true }
            });

            if(!project){
                await deleteInstanceLifecycle(instance.instanceId);
                return false;
            }

            await appendProjectEvent({
                projectId: project.id,
                ownerId: project.ownerId,
                eventType: "RUNTIME_RECOVERY_STARTED",
                message: reason,
                instanceId: instance.instanceId,
                publicIp: instance.publicIP,
                containerName: instance.containerName,
                fromStatus: project.status,
                toStatus: project.status,
            });

            await cleanupProjectRuntimeAssignment(instance.projectId, project.ownerId);

            await markProjectFailed(instance.projectId, reason, {
                assignedInstanceId : null,
                containerName : null,
                publicIp : null,
                lastHeartbeatAt : null,
            },
            "HEARTBEAT_FAILED");

            await appendProjectEvent({
                projectId: project.id,
                ownerId: project.ownerId,
                eventType: "RUNTIME_RECOVERY_COMPLETED",
                message: `Recovered runtime after failure on instance ${instance.instanceId}`,
                instanceId: instance.instanceId,
                publicIp: instance.publicIP,
                containerName: instance.containerName,
                fromStatus: "FAILED",
                toStatus: "FAILED",
            });

            logInfo({
                projectId: instance.projectId,
                userId: instance.userId,
                instanceId: instance.instanceId,
                containerName: instance.containerName,
                operation: "runtime.recovery.completed",
                status: "SUCCESS",
                reason: `Recovered runtime after failure on instance ${instance.instanceId}`,
                meta: {
                    publicIP: instance.publicIP,
                },
            });

            return true;
        }
    );

    if (recoveryResult === null) {
        logWarn({
            projectId: instance.projectId,
            userId: instance.userId,
            instanceId: instance.instanceId,
            containerName: instance.containerName,
            operation: "runtime.recovery.locked_or_skipped",
            status: "SKIPPED",
            reason: "Recovery lock not acquired",
            meta: {
                publicIP: instance.publicIP,
            },
        });
    return false;
    }

    if (recoveryResult === false) {
        logWarn({
            projectId: instance.projectId,
            userId: instance.userId,
            instanceId: instance.instanceId,
            containerName: instance.containerName,
            operation: "runtime.recovery.locked_or_skipped",
            status: "SKIPPED",
            reason: "Recovery skipped because runtime assignment or project was no longer active",
            meta: {
                publicIP: instance.publicIP,
            },
        });
        return false;
    }
    return recoveryResult;
}

export const handleHeartbeatFailure = async(
    instance : InstanceRecord,
    reason : string,
    severity : HealthSeverity,
): Promise<"SOFT_RECORDED" | "RECOVERED" | "LOCKED_OR_SKIPPED"> => {

    logWarn({
        projectId: instance.projectId,
        userId: instance.userId,
        instanceId: instance.instanceId,
        containerName: instance.containerName,
        operation: "heartbeat.failure",
        status: "FAILED",
        reason,
        meta: {
            severity,
            publicIP: instance.publicIP,
        },
    });

    if(severity === "HARD"){
        logWarn({
            projectId: instance.projectId,
            userId: instance.userId,
            instanceId: instance.instanceId,
            containerName: instance.containerName,
            operation: "heartbeat.threshold_reached",
            status: "FAILED",
            reason,
            meta: {
                threshold: HEARTBEAT_FAILURE_THRESHOLD,
                publicIP: instance.publicIP,
            },
        });

        const recovered = await recoverProjectRuntime(instance,reason);
        return recovered ? "RECOVERED" : "LOCKED_OR_SKIPPED";
    }

    const failures = await incrementHeartbeatFailure(instance.instanceId,reason);

    if(failures === null){
        return "LOCKED_OR_SKIPPED";
    }

    if(failures < HEARTBEAT_FAILURE_THRESHOLD){
        return "SOFT_RECORDED";
    };

    logWarn({
        projectId: instance.projectId,
        userId: instance.userId,
        instanceId: instance.instanceId,
        containerName: instance.containerName,
        operation: "heartbeat.threshold_reached",
        status: "FAILED",
        reason,
        meta: {
            threshold: HEARTBEAT_FAILURE_THRESHOLD,
            failures,
            publicIP: instance.publicIP,
        },
    });
    
    const recovered = await recoverProjectRuntime(instance,
        `Heartbeat failure threshold reached. ${reason}`
    );

    return recovered ? "RECOVERED" : "LOCKED_OR_SKIPPED";
}

export const runHeartbeatReconcile = async () : Promise<HeartbeatRunSummary> => {
    const summary : HeartbeatRunSummary = {
        scanned : 0,
        healthy : 0,
        softFailures : 0,
        hardFailures : 0,
        recovered : 0,
        skipped : 0,
        errors : 0,
    };

    const activeInstances = await listActiveAssignedInstances();
    summary.scanned = activeInstances.length;

    for( const instance of activeInstances ){
        try{
            const health = await checkRuntimeHealth(instance);

            if(health.healthy){
                await handleHeartbeatSuccess(instance);
                summary.healthy += 1;
                continue;
            }

            if(health.severity === "SOFT"){
                summary.softFailures += 1;
            } else {
                summary.hardFailures += 1;
            }

            const outcome = await handleHeartbeatFailure(
                instance,
                health.reason,
                health.severity,
            );

            if(outcome === "RECOVERED"){
                summary.recovered += 1;
            } else if (outcome === "LOCKED_OR_SKIPPED"){
                summary.skipped += 1;
            }
        } catch(err){
            summary.errors += 1;
            logError({
                projectId: instance.projectId,
                userId: instance.userId,
                instanceId: instance.instanceId,
                containerName: instance.containerName,
                operation: "heartbeat.reconcile.error",
                status: "FAILED",
                reason: err instanceof Error ? err.message : "Unknown heartbeat reconcile error",
                meta: {
                    publicIP: instance.publicIP,
                },
            });
        }
    } 

    return summary;
}