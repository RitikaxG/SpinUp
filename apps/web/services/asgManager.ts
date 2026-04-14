import { terminateAndScaleDown, getAutoScalingGroupState, setDesiredCapacityIfChanged } from "../lib/aws/asgCommands"
import type { AutoScalingGroupState } from "../lib/aws/asgCommands";
import { markProjectFailed } from "./projectLifecycleManager";
import { InstanceStatus, getInstance, deleteInstanceLifecycle, withDistributedLock } from "./redisManager";
import { prisma } from "db/client";
import { AUTOSCALING_CONFIG } from "../lib/autoscaling/config";
import { getAssignedProjectByInstanceId, listBusyInstanceIds } from "./projectRuntimeTruthSource";
import { createScopedLogger, logError, logInfo, logWarn } from "../lib/observability/structuredLogger";

interface InstanceInfo {
    InstanceId? : string;
    LifecycleState? : string;
    HealthStatus? : string;
    inUse? : boolean; 
    status? : InstanceStatus | "UNTRACKED"
    lastHeartbeatAt? : number;
    dbAssignedProjectId?: string | null;
    dbAssignedStatus?: string | null;
}

export type ScalingSnapshot = {
  totalInstances : number,
  desiredCapacity : number,
  healthyInServiceCount : number,
  unhealthyCount : number,
  idleCount : number,
  busyCount : number,
  idleInstanceIds : string[]
}

export type ScalingPlan = 
  | { action : "SCALE_UP"; targetDesiredCapacity : number; reason : string }
  | { action : "KEEP"; reason : string }
  | { action : "RECYCLE_IDLE"; instanceIds : string[] ; reason : string  };

const isHealthyInService = (instance : InstanceInfo ) => {
  return (
    instance.HealthStatus === "Healthy" &&
    instance.LifecycleState === "InService"
  )
}

const isIdleCandidate = (instance: InstanceInfo) => {
  return (
    isHealthyInService(instance) &&
    !instance.dbAssignedProjectId &&
    (instance.status === "IDLE" || instance.status === "UNTRACKED")
  );
};

export const getAllInstancesInfo = async ( groupState? : AutoScalingGroupState) : Promise<InstanceInfo[]> => {
    const state = groupState ?? (await getAutoScalingGroupState());
    
    const busySet = await listBusyInstanceIds();

    const instanceDetails = await Promise.all(
        state.instances.map(async (instance): Promise<InstanceInfo> => {

        const instanceId = instance.InstanceId;
        if(!instanceId){
            return{
                InstanceId: undefined,
                LifecycleState: instance.LifecycleState,
                HealthStatus: instance.HealthStatus,
                inUse: false,
                status: "UNTRACKED",
                lastHeartbeatAt: 0,
                dbAssignedProjectId: null,
                dbAssignedStatus: null,
            }
        }

        const redisRecord = await getInstance(instanceId);

        const assignedProject = busySet.has(instanceId)
        ? await getAssignedProjectByInstanceId(instanceId)
        : null;

        return {
            InstanceId : instanceId,
            LifecycleState : instance.LifecycleState,
            HealthStatus : instance.HealthStatus,
            inUse : redisRecord ? redisRecord.inUse === "true" : false,
            status: redisRecord?.status ?? "UNTRACKED",
            lastHeartbeatAt : Number(redisRecord?.lastHeartbeatAt ?? 0),
            dbAssignedProjectId: assignedProject?.id ?? null,
            dbAssignedStatus: assignedProject?.status ?? null,
        }
        })
    ) 

    return instanceDetails;  
}

const terminateIdleInstance = async ( instanceId : string, reason : string ) : Promise<boolean> => {
  const logger = createScopedLogger({
    instanceId,
  });

  const assignedProject = await getAssignedProjectByInstanceId(instanceId);
  if (assignedProject) {
    logger.warn({
      operation: "instance.termination.skipped",
      status: "SKIPPED",
      reason: "Instance still has assigned project in DB",
      meta: {},
    });
    return false;
  }

  const redisRecord = await getInstance(instanceId);
  if(redisRecord?.inUse === "true"){
    logger.warn({
      operation: "instance.termination.skipped",
      status: "SKIPPED",
      reason: "Redis lifecycle still marks instance as in use",
      meta: {},
    });
    return false;
  }

  logger.info({
    operation: "instance.termination.requested",
    status: "STARTED",
    reason,
    meta: {
      shouldDecreaseCapacity: true,
    },
  });
  await terminateAndScaleDown(instanceId, true);

  logger.info({
    operation: "instance.terminated",
    status: "SUCCESS",
    reason,
    meta: {
      shouldDecreaseCapacity: true,
    },
  });

  await deleteInstanceLifecycle(instanceId);
  return true;
}

const reapTimedOutIdleInstances = async() : Promise<string[]> => {
  const timeoutMs = AUTOSCALING_CONFIG.IDLE_TIMEOUT_MINUTES * 60 * 1000;
  const now = Date.now();
  
  const instances = await getAllInstancesInfo();

  const expiredIdleInstances = instances
    .filter((instance) => 
      isIdleCandidate(instance) &&
      Boolean(instance.InstanceId) &&
      (instance.lastHeartbeatAt ?? 0) > 0 &&
      now - (instance.lastHeartbeatAt ?? 0) > timeoutMs 
    ).sort(
      (a,b) => (a.lastHeartbeatAt ?? 0) - (b.lastHeartbeatAt ?? 0)
    )
    .map((instance) => instance.InstanceId!)
    .filter(Boolean);

  const terminated : string[] = [];

  for(const instanceId of expiredIdleInstances){
    const didTerminate = await terminateIdleInstance(
      instanceId,
      "idle timeout exceeded"
    );

    if(didTerminate){
      terminated.push(instanceId);

      logInfo({
        instanceId,
        operation: "instance.idle_timeout_termination",
        status: "SUCCESS",
        reason: "idle timeout exceeded",
        meta: {},
      });
    }else{
      logWarn({
        instanceId,
        operation: "instance.idle_timeout_termination",
        status: "SKIPPED",
        reason: "Idle timeout exceeded but instance was not terminated",
        meta: {},
      });
    }
  }

  return terminated;
}

const runScaleUpUnderLock = async () : Promise<ScalingPlan | null> => {
  return withDistributedLock<ScalingPlan>(
    AUTOSCALING_CONFIG.SCALE_UP_LOCK_KEY,
    AUTOSCALING_CONFIG.SCALE_UP_LOCK_TTL_MS,
    async () => {
      const freshSnapshot = await getScalingSnapshot();
      const freshPlan = computeScalingPlan(freshSnapshot);

      if(freshPlan.action !== "SCALE_UP"){
        return freshPlan;
      }

      const scaleResult = await setDesiredCapacityIfChanged(freshPlan.targetDesiredCapacity);

      if (scaleResult.changed) {
        logInfo({
          operation: "capacity.scale_up.triggered",
          status: "SUCCESS",
          reason: freshPlan.reason,
          meta: {
            previousDesiredCapacity: scaleResult.previousDesiredCapacity,
            desiredCapacity: scaleResult.desiredCapacity,
            groupName: scaleResult.groupName,
          },
        });
      } else {
        logWarn({
          operation: "capacity.scale_up.skipped",
          status: "SKIPPED",
          reason: "Desired capacity already at target",
          meta: {
            desiredCapacity: scaleResult.desiredCapacity,
            groupName: scaleResult.groupName,
          },
        });
      }
      return freshPlan;
    }
  )
}

export const ensureIdleCapacityForAllocation = async(): Promise<ScalingPlan> => {
  const snapshot = await getScalingSnapshot();

  // Request-time fast path: if at least one idle instance exists,
  // allocation can proceed immediately.
  if(snapshot.idleCount >= 1 ){
    logInfo({
      operation: "capacity.idle_instance.found",
      status: "SUCCESS",
      reason: `Idle capacity already available (${snapshot.idleCount} idle instance(s))`,
      meta: {
        idleCount: snapshot.idleCount,
        desiredCapacity: snapshot.desiredCapacity,
      },
    });

    return {
      action : "KEEP",
      reason : `Idle capacity already available (${snapshot.idleCount} idle instance(s))`,
    }
  }

  const plan = computeScalingPlan(snapshot);
  if (plan.action !== "SCALE_UP") {
    logWarn({
      operation: "capacity.scale_up.skipped",
      status: "SKIPPED",
      reason: plan.reason,
      meta: {
        idleCount: snapshot.idleCount,
        desiredCapacity: snapshot.desiredCapacity,
      },
    });
    return plan;
  }

  const lockedPlan = await runScaleUpUnderLock();
  if(!lockedPlan){

    logWarn({
      operation: "capacity.scale_up.skipped",
      status: "SKIPPED",
      reason: "Scale up already in progress by another request",
      meta: {},
    });

    return {
      action : "KEEP",
      reason : "Scale up already in progress by another request"
    }
  }

  
  return lockedPlan;

}


export const getReadyInstances = async () => {
    const instances = await getAllInstancesInfo();
    return instances.filter(isHealthyInService);
}

export const getUnhealthyInstances = async () => {
    const instances = await getAllInstancesInfo();
    return instances.filter((instance) => instance.HealthStatus === "Unhealthy");
}

export const getIdleMachines = async () => {
    const instances = await getAllInstancesInfo();
    return instances.filter(isIdleCandidate)
}

export const getScalingSnapshot = async() : Promise<ScalingSnapshot> => {
  const groupState = await getAutoScalingGroupState();
  const instances = await getAllInstancesInfo(groupState);

  const healthyInServiceInstances = instances.filter(isHealthyInService);
  const unhealthyInstances = instances.filter((instance) => instance.HealthStatus === "Unhealthy");

  const orderedIdleInstances = healthyInServiceInstances
    .filter(isIdleCandidate)
    .sort((a,b) => (a.lastHeartbeatAt ?? 0) - (b.lastHeartbeatAt ?? 0));

  const busyInstances = healthyInServiceInstances.filter((instance) => !isIdleCandidate(instance));

  return {
    totalInstances : groupState.totalInstances,
    desiredCapacity : groupState.desiredCapacity,
    healthyInServiceCount : healthyInServiceInstances.length,
    unhealthyCount : unhealthyInstances.length,
    idleCount : orderedIdleInstances.length,
    busyCount: busyInstances.length,
    idleInstanceIds : orderedIdleInstances
      .map((instance) => instance.InstanceId)
      .filter((instanceId): instanceId is string => Boolean(instanceId))
  }
};

export const computeScalingPlan = (
  snapshot : ScalingSnapshot
): ScalingPlan => {
  const { MIN_IDLE, MAX_IDLE, MAX_TOTAL_INSTANCES } = AUTOSCALING_CONFIG;

   // Rule 1: unhealthy instances are handled separately by unhealthy cleanup.
   if(snapshot.unhealthyCount > 0){
    return {
      action : "KEEP",
      reason : "Unhealthy instances are handled seperately before scale decisions"
    }
   }

   // Rule 2: below minimum idle pool -> scale up.
   if(snapshot.idleCount < MIN_IDLE){
    const missingIdle = MIN_IDLE - snapshot.idleCount;
    const currentCapacityBase = Math.max(
      snapshot.desiredCapacity,
      snapshot.totalInstances
    );

    const targetDesiredCapacity = Math.min(currentCapacityBase + missingIdle, MAX_TOTAL_INSTANCES);

    if(targetDesiredCapacity > snapshot.desiredCapacity){
      return {
        action : "SCALE_UP",
        targetDesiredCapacity,
        reason : `Idle count ${snapshot.idleCount} is below min idle ${MIN_IDLE}`
      }
    }

    return {
      action : "KEEP",
      reason : "Idle count is low but cluster is already at MAX_TOTAL_INSTANCES"
    }
   }

  // Rule 3: idle count within band -> keep current capacity.
  if(snapshot.idleCount <= MAX_IDLE){
    return {
      action : "KEEP",
      reason : `Idle count ${snapshot.idleCount} is within target band ${MIN_IDLE}-${MAX_IDLE}`
    }
  };

  // Rule 4: idle count above maximum -> recycle oldest idle instances.
  const overflow = snapshot.idleCount - MAX_IDLE;

  return {
    action : "RECYCLE_IDLE",
    instanceIds : snapshot.idleInstanceIds.slice(0,overflow),
    reason : `Idle count ${snapshot.idleCount} is above max idle`
  }
}



export const terminatingUnhealthyInstances = async () => {
  const unhealthyInstances = await getUnhealthyInstances();

  for (const instance of unhealthyInstances) {
    if (!instance.InstanceId) {
      continue;
    }

    const instanceId = instance.InstanceId;
    const assignedProject = await getAssignedProjectByInstanceId(instanceId);

    try {
      logWarn({
        projectId: assignedProject?.id ?? null,
        userId: assignedProject?.ownerId ?? null,
        instanceId,
        operation: "instance.unhealthy_cleanup.started",
        status: "STARTED",
        reason: "ASG instance became unhealthy",
        meta: {},
      });
      // 1) Reflect failure in DB if this unhealthy instance was assigned
      if (assignedProject) {
        await prisma.projectRoom.updateMany({
          where: {
            projectId: assignedProject.id,
            userId: assignedProject.ownerId,
          },
          data: {
            vmState: "FAILED",
          },
        });

        await markProjectFailed(assignedProject.id,
            "ASG instance became unhealthy",{
                assignedInstanceId: null,
                containerName: null,
                publicIp: null,
                lastHeartbeatAt: null
            },
            "RUNTIME_RECOVERY_STARTED"
        )
      }

      // 2) Terminate unhealthy EC2 instance
      await terminateAndScaleDown(instanceId, false);

      // 3) Remove stale Redis lifecycle
      await deleteInstanceLifecycle(instanceId);

      logInfo({
        projectId: assignedProject?.id ?? null,
        userId: assignedProject?.ownerId ?? null,
        instanceId,
        operation: "instance.unhealthy_cleanup.completed",
        status: "SUCCESS",
        reason: "Unhealthy instance terminated and lifecycle removed",
        meta: {},
      });

    } catch (err: unknown) {
      if (err instanceof Error) {
        logError({
          projectId: assignedProject?.id ?? null,
          userId: assignedProject?.ownerId ?? null,
          instanceId,
          operation: "instance.unhealthy_cleanup.failed",
          status: "FAILED",
          reason: err instanceof Error ? err.message : "Unknown unhealthy cleanup error",
          meta: {},
        });

        console.error(
          `Failed unhealthy-instance cleanup for ${instanceId}: ${err.message}`
        );
      } else {
        console.error(`Failed unhealthy-instance cleanup for ${instanceId}`);
      }
    }
  }
};

export const reconcileAutoScaling = async () => {
  await terminatingUnhealthyInstances();

  const timedOutIdleInstanceIds = await reapTimedOutIdleInstances();

  const snapshot = await getScalingSnapshot();
  const plan = computeScalingPlan(snapshot);

  if(plan.action === "RECYCLE_IDLE"){
    for(const instanceId of plan.instanceIds){
      
      const didTerminate = await terminateIdleInstance(instanceId,"pool over target");
      if (didTerminate) {
        logInfo({
            instanceId,
            operation: "instance.recycled_from_idle_overflow",
            status: "SUCCESS",
            reason: "pool over target",
            meta: {},
          });
      } else {
          logWarn({
              instanceId,
              operation: "instance.recycled_from_idle_overflow",
              status: "SKIPPED",
              reason: "Idle overflow candidate was not terminated",
              meta: {},
          });
      }
    }

    

    return {
      action : plan.action,
      reason : plan.reason,
      timedOutIdleInstanceIds,
      recycledIdleInstanceIds : plan.instanceIds
    }
  }

  if(plan.action === "SCALE_UP"){
    const lockedPlan = await runScaleUpUnderLock();

    return {
      action : lockedPlan?.action ?? "KEEP",
      reason: lockedPlan?.reason ?? "Scaleup already in progress by another reconciler",
      timedOutIdleInstanceIds,
      recycledIdleInstanceIds : [],
    }
  }

  return {
    action : plan.action,
    reason : plan.reason,
    timedOutIdleInstanceIds,
    recycledIdleInstanceIds : []
  }
}


export const reconcileWarmPool = async () => {
  return reconcileAutoScaling();
};