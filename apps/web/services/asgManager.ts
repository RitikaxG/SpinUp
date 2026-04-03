import { getASGInstances, setDesiredCapacity, getDesiredCapacity, terminateAndScaleDown } from "../lib/aws/asgCommands"
import { InstanceStatus, getInstance, deleteInstanceLifecycle } from "./redisManager";


interface InstanceInfo {
    InstanceId? : string;
    LifecycleState? : string;
    HealthStatus? : string;
    inUse? : boolean; 
    status? : InstanceStatus | "UNTRACKED"
}

const THRESHOLD_IDLE_MACHINE_COUNT = 5;


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

export const terminatingUnhealthyInstances = async() => {
    const unhealthyInstances = await getUnhealthyInstances();
     for ( const instance of unhealthyInstances ){
        
        if(!instance.InstanceId){
            continue;
        }

        console.log(`Terminating unhealthy instance ${instance.InstanceId}`);

        await terminateAndScaleDown(instance.InstanceId!, false);
        await deleteInstanceLifecycle(instance.InstanceId)
    }
}

const idleMachines = await getIdleMachines();
console.log(idleMachines);
console.log(idleMachines.length);

getAllInstancesInfo();
