import { promise } from "zod";
import { getASGInstances, setDesiredCapacity, getDesiredCapacity, terminateAndScaleDown } from "../lib/aws/asgCommands"
import { markProjectFailed } from "./projectLifecycleManager";
import { InstanceStatus, getInstance, deleteInstanceLifecycle } from "./redisManager";
import { prisma } from "db/client";

interface InstanceInfo {
    InstanceId? : string;
    LifecycleState? : string;
    HealthStatus? : string;
    inUse? : boolean; 
    status? : InstanceStatus | "UNTRACKED"
}

const THRESHOLD_IDLE_MACHINE_COUNT = 5;
const IDLE_TIMEOUT_MS = 20*60*1000; // 20 minutes

const terminateIdleInstance = async ( instanceId : string, reason : string ) => {
  const redisRecord = await getInstance(instanceId);
  if(redisRecord?.inUse === "true"){
    return false;
  }

  console.log(`Scaling in idle instance ${instanceId} . Reason : ${reason}`);
  await terminateAndScaleDown(instanceId, true);
  await deleteInstanceLifecycle(instanceId);
  return true;
}

export const reconcileWarmPool = async() => {
  const idleMachines = await getIdleMachines();
  const now = Date.now();

  const candidates = ( await Promise.all(
    idleMachines.filter((instance) => instance.InstanceId)
    .map(async (instance) => {
      const instanceId = instance.InstanceId!;
      const redisRecord = await getInstance(instanceId);

      return {
        instanceId,
        status : instance.status,
        lastHeartbeatAt : Number(redisRecord?.lastHeartbeatAt ?? 0)
      }
    })
  )
  ).sort((a,b) => a.lastHeartbeatAt - b.lastHeartbeatAt)

  // 1. Expire old idle instances
  for(const candidate of candidates){
    if(candidate.lastHeartbeatAt > 0 && now - candidate.lastHeartbeatAt > IDLE_TIMEOUT_MS){
      await terminateIdleInstance(candidate.instanceId,"idle timeout exceeded")
    }
  }

  // 2. Shrink pool if still above target
  const refreshedIdleMachines = await getIdleMachines();
  const overflow = refreshedIdleMachines.length - THRESHOLD_IDLE_MACHINE_COUNT;
  if(overflow >= 0){
    return
  }

  const refreshedCandidates = (
    await Promise.all(
      refreshedIdleMachines
      .filter((instance) => instance.InstanceId)
      .map(async (instance) => {
        const instanceId = instance.InstanceId!
        const redisRecord = await getInstance(instanceId);

        return {
          instanceId,
          lastHeartbeatAt : Number(redisRecord?.lastHeartbeatAt ?? 0)
        }
      })
    )
  ).sort((a,b) => a.lastHeartbeatAt- b.lastHeartbeatAt) 

  for(const candidate of refreshedCandidates.slice(0,overflow)){
    await terminateIdleInstance(candidate.instanceId, "pool over target")
  }
}


export const getAllInstancesInfo = async () : Promise<InstanceInfo[]> => {
    const instances = await getASGInstances();

    const instanceDetails = await Promise.all(
        instances.map(async (instance): Promise<InstanceInfo> => {

        const instanceId = instance.InstanceId;
        if(!instanceId){
            return{
                InstanceId: undefined,
                LifecycleState: instance.LifecycleState,
                HealthStatus: instance.HealthStatus,
                inUse: false,
                status: "UNTRACKED"
            }
        }

        const redisRecord = await getInstance(instanceId);
    
        return {
            InstanceId : instanceId,
            LifecycleState : instance.LifecycleState,
            HealthStatus : instance.HealthStatus,
            inUse : redisRecord ? redisRecord.inUse === "true" : false,
            status: redisRecord?.status ?? "UNTRACKED"
        }
        })
    ) 
    console.log(instanceDetails);
    return instanceDetails;  
}

export const getReadyInstances = async () => {
    const instances = await getAllInstancesInfo();
    return instances.filter((instance) => instance.HealthStatus === "Healthy" && instance.LifecycleState === "InService");
}

export const getUnhealthyInstances = async () => {
    const instances = await getAllInstancesInfo();
    return instances.filter((instance) => instance.HealthStatus === "Unhealthy");
}

export const getIdleMachines = async () => {
    const instances = await getAllInstancesInfo();

    const idleMachines = instances.filter((instance) => {
    const isHealthy = instance.HealthStatus === "Healthy";
    const isInService = instance.LifecycleState === "InService";
    const isIdle =
      instance.status === "IDLE" || instance.status === "UNTRACKED";

    return isHealthy && isInService && isIdle;
    });
    return idleMachines;
}

export const checkAndScaleUp = async () => {
    const idleMachines = await getIdleMachines();
    const desiredCapacity = await getDesiredCapacity();

    if (idleMachines.length < THRESHOLD_IDLE_MACHINE_COUNT) {
        const scaleTarget = desiredCapacity + (THRESHOLD_IDLE_MACHINE_COUNT - idleMachines.length);
        console.log(`Increasing idle machine count from ${desiredCapacity} => ${scaleTarget}`);
        await setDesiredCapacity(scaleTarget);
    } else {
        console.log(`Sufficient idle machine count ${idleMachines.length}`);
    }
};

export const terminatingUnhealthyInstances = async () => {
  const unhealthyInstances = await getUnhealthyInstances();

  for (const instance of unhealthyInstances) {
    if (!instance.InstanceId) {
      continue;
    }

    const instanceId = instance.InstanceId;
    const redisRecord = await getInstance(instanceId);

    try {
      // 1) Reflect failure in DB if this unhealthy instance was assigned
      if (redisRecord?.projectId && redisRecord?.userId) {
        await prisma.projectRoom.updateMany({
          where: {
            projectId: redisRecord.projectId,
            userId: redisRecord.userId,
          },
          data: {
            vmState: "FAILED",
          },
        });

        await markProjectFailed(redisRecord.projectId,
            "ASG instance became unhealthy",{
                assignedInstanceId: null,
                containerName: null,
                publicIp: null,
                lastHeartbeatAt: null
            }
        )
      }

      // 2) Terminate unhealthy EC2 instance
      console.log(`Terminating unhealthy instance ${instanceId}`);
      await terminateAndScaleDown(instanceId, false);

      // 3) Remove stale Redis lifecycle
      await deleteInstanceLifecycle(instanceId);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(
          `Failed unhealthy-instance cleanup for ${instanceId}: ${err.message}`
        );
      } else {
        console.error(`Failed unhealthy-instance cleanup for ${instanceId}`);
      }
    }
  }
};

