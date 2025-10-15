import { getASGInstances, setDesiredCapacity, getDesiredCapacity, terminateAndScaleDown } from "../lib/aws/asgCommands"
import { getPublicIP } from "../lib/aws/ec2Commands";
import { redis } from "./redisManager";


interface Instance {
    InstanceId? : string;
    LifecycleState? : string;
    HealthStatus? : string;
    inUse? : boolean; 
}

const THRESHOLD_IDLE_MACHINE_COUNT = 5;


export const getAllInstancesInfo = async () : Promise<Instance[]> => {
    const instances = await getASGInstances();

    const instanceDetails = await Promise.all(
        instances.map(async (instance) => {
        const publicIP  = await getPublicIP(instance.InstanceId!);
        const redisData = await redis.hgetall(`instance:${instance.InstanceId}`)
            return {
            InstanceId : instance.InstanceId,
            LifecycleState : instance.LifecycleState,
            HealthStatus : instance.HealthStatus,
            inUse : redisData.inUse === "true" ? true : false,
            publicIp : publicIP
            }
        })
    ) 
    console.log(instanceDetails);
    return instanceDetails;  
}

export const getReadyInstances = async () => {
    const instances = await getAllInstancesInfo();
    const activeInstances = instances.filter(instance => instance.HealthStatus === "Healthy" && instance.LifecycleState === "InService");
    return activeInstances;
}

export const getUnhealthyInstances = async () => {
    const instances = await getAllInstancesInfo();
    const unhealthyInstances = instances.filter((instance) => instance.HealthStatus === "Unhealthy");
    return unhealthyInstances;
}

export const getIdleMachines = async () => {
    const instances = await getAllInstancesInfo();
    const idleMachines = instances.filter((instance) => instance.HealthStatus === "Healthy" && instance.LifecycleState === "InService" && instance.inUse === false)
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
        console.log(`Terminating unhealthy instance ${instance.InstanceId}`)
        await terminateAndScaleDown(instance.InstanceId!, false);
    }
}

const idleMachines = await getIdleMachines();
console.log(idleMachines);
console.log(idleMachines.length);

getAllInstancesInfo();
