import axios from "axios";
import { cleanupProjectRuntimeAssignment, controlPlaneLockKeys, deleteInstanceLifecycle, getInstance, getInstanceIdForProject, incrementHeartbeatFailure, InstanceRecord, listActiveAssignedInstanceIds, resetHeartbeatFailure, updateInstanceHeartbeat, withDistributedLock } from "./redisManager";
import { CONTAINER_STATUS_TIMEOUT_MS, HEALTH_TIMEOUT_MS, HEARTBEAT_FAILURE_THRESHOLD, PROJECT_RUNTIME_LOCK_TTL_MS } from "../lib/control-plane/config";
import { markProjectFailed, touchProjectHeartbeat } from "./projectLifecycleManager";
import { prisma } from "db/client";

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

export const listActiveAssignedInstances = async() : Promise<InstanceRecord[]> => {
    const instanceIds = await listActiveAssignedInstanceIds();
    const records = await Promise.all(instanceIds.map((instanceId) => getInstance(instanceId)))

    return records.filter((record): record is InstanceRecord => {
        return Boolean(
            record &&
            record.inUse === "true" &&
            record.projectId &&
            record.userId &&
            record.publicIP &&
            record.status === "RUNNING"
        )
    })
}

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
};

export const recoverProjectRuntime = async(
    instance : InstanceRecord,
    reason : string,
) : Promise<boolean> => {
    const locked = await withDistributedLock(
        controlPlaneLockKeys.runtime(instance.projectId),
        PROJECT_RUNTIME_LOCK_TTL_MS,
        async () => {
            const latestProjectMapping = await getInstanceIdForProject(instance.projectId);

            if(!latestProjectMapping && latestProjectMapping !== instance.instanceId){
                await deleteInstanceLifecycle(instance.instanceId);
                return false;
            }

            const project = await prisma.project.findUnique({
                where : { id : instance.projectId },
                select : { id : true, ownerId : true, status : true }
            });

            if(!project){
                await deleteInstanceLifecycle(instance.instanceId);
                return null;
            }

            await markProjectFailed(instance.projectId, reason, {
                assignedInstanceId : null,
                containerName : null,
                publicIp : null,
                lastHeartbeatAt : null,
            });

            await cleanupProjectRuntimeAssignment(instance.projectId, project.ownerId);
            return true;
        }
    )
    if(!locked){
        return false;
    }
    return locked;
}

export const handleHeartbeatFailure = async(
    instance : InstanceRecord,
    reason : string,
    severity : HealthSeverity,
): Promise<"SOFT_RECORDED" | "RECOVERED" | "LOCKED_OR_SKIPPED"> => {
    if(severity === "HARD"){
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
            console.error(
                `[heartbeat] failed for instance ${instance.instanceId}`,
                err instanceof Error ? err.message : err,
            )
        }
    } 

    return summary;
}