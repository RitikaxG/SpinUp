import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import { getPublicIP } from "../lib/aws/ec2Commands";
import { checkAndScaleUp, getIdleMachines } from "./asgManager"
import { cleanUpInstanceInRedis, markInstanceInUse, redis } from "./redisManager";
import axios from "axios";

const INSTANCE_WAIT_TIMEOUT = 180_000;
const POLL_INTERVAL = 5000;

export const allocateVmAndScaleUp = async () => {
    let idleMachines = await getIdleMachines();
    if(idleMachines.length > 0){
        return { instanceId : idleMachines[0]?.InstanceId }
    }
   
    console.log(`No idle machines found scaling up`);
    await checkAndScaleUp();

    // Wait for an idle machine to become available
    const start = Date.now();

    while(Date.now() - start < INSTANCE_WAIT_TIMEOUT){
        idleMachines = await getIdleMachines();
        if(idleMachines.length > 0){
            console.log(`Successfully scaled up and found an idle machine`);
            return { instanceId : idleMachines[0]?.InstanceId }
        }
        
        // Sleep before next check
        await new Promise(res => setTimeout(res, POLL_INTERVAL));
    }
    console.error(`No idle machines within instance wait timeout seems like max instance limit reached`);
    return { instanceId : null }
}

export const vmBootingSetup = async (projectId : string, projectName : string, projectType : string, userId : string) => {

    // 1. Check if that user already have a VM assigned ( this will return it's ID )
    const exisitingVmId = await redis.get(`user:${userId}:instance`);
    if(exisitingVmId){
        const existingVmMetaData = await redis.hgetall(`instance:${exisitingVmId}`);
        if(!existingVmMetaData.projectId){
            return `Existing active vm metadata doesn't have project id associated with it`;
        }
        await cleanUpInstanceInRedis(existingVmMetaData.projectId);
    }
    
    // 2. Get an idle instance
    const allocation = await allocateVmAndScaleUp();
    if(!allocation.instanceId){
        console.error("No instance allocated to start booting");
        return;
    }
    const instanceId = allocation.instanceId;

    // 3. Get its public IP
    const publicIP   = await getPublicIP(instanceId);
    if(!publicIP){
        console.error(`Failed to fetch public IP for instance ${instanceId}`);
        await terminateAndScaleDown(instanceId,true); // rollback
        return;
    }

    
    // 4. Start my-code-server container inside VM
    let containerName;
    try{
        const startContainer = await axios.post(`http://${publicIP}:3000/start`,{
        projectId, 
        projectName, 
        projectType 
        })
        containerName = startContainer.data.conatinerName;
    }
    catch(err:unknown){
        if(err instanceof Error){
            console.error(`Unable to start container inside instance ${instanceId} ${err}`);
            await terminateAndScaleDown(instanceId,true); // rollback if container does not starts
            return;
        }
    }
    
    
    console.log(containerName);

    // 5. Mark instance:${instanceId} key in redis
    await markInstanceInUse(userId, instanceId, projectId, projectName, projectType, publicIP, containerName);
   

    return {
        userId,
        instanceId,
        publicIP,
        projectId,
        projectName,
        projectType,
        containerName
    }
}

export const heartBeat = async () => {
    
    const instances = await redis.keys("instance:*");
    console.log(`Heartbeat check for ${instances.length} instances...`);

    for(const instance of instances){
        const containerName = await redis.hget(instance,"containerName");
        const publicIP      = await redis.hget(instance,"publicIP");
        const projectId     = await redis.hget(instance,"projectId");
        const instanceId    = await redis.hget(instance,"instanceId");

        if(!containerName || !publicIP || !projectId || !instanceId){
            console.error(`Skipping ${instance} : missing data in redis`);
            continue;
        }

        let shouldTerminate = false;
        // Check container status
        try{
            const containerStatus = await axios.post(`http://${publicIP}:3000/containerStatus`,{
                containerName
            },{
                timeout : 5000
            });

            if(containerStatus.data.status === "stopped"){
                console.log(`Terminating instance ${instanceId} since containerStatus is stopped..`)
                shouldTerminate = true;
            }
        }
        catch(err : unknown){
            if(err instanceof Error){
                console.error(`Error checking container status for ${instanceId} terminating instance ${err.message}...`);
                shouldTerminate = true;
            }
            
        }
        
        // Heath Check
        try{
            const healthCheck = await axios.get(`http://${publicIP}:3000/health`);
            if(healthCheck.data !== "OK"){
                console.error(`Heath check failed for ${instanceId}`);
                shouldTerminate = true
            }
        }
        catch(err : unknown){
            if(err instanceof Error){
                console.error(`Heath check request failed for ${instanceId} terminating instance...`);
                shouldTerminate = true;
            }
        }

        if(shouldTerminate){
            console.log(`Terminating instances ...`)
            await cleanUpInstanceInRedis(projectId);
        }  
    }
}

