import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import { getPublicIP } from "../lib/aws/ec2Commands";
import { checkAndScaleUp, getIdleMachines } from "./asgManager"
import { cleanUpOwnedProjectInstance, markInstanceInUse, redis } from "./redisManager";
import axios from "axios";
import { prisma } from "db/client";

const INSTANCE_WAIT_TIMEOUT = 180_000;
const POLL_INTERVAL = 5000;

type ProjectTypeValue = "NEXTJS"| "REACT" | "REACT_NATIVE"
type VmStateValue = "RUNNING" | "STOPPED" | "FAILED" | "TERMINATING" | "BOOTING"

const updateVmState = async (
    projectId : string,
    userId : string,
    vmState : VmStateValue
) => {
    await prisma.projectRoom.updateMany({
        where: {
            projectId,
            userId,
        },
        data: {
            vmState
        }
    })
}

export const allocateVmAndScaleUp = async () => {
    let idleMachines = await getIdleMachines();

    if(idleMachines.length > 0){
        return { instanceId : idleMachines[0]?.InstanceId ?? null}
    }
   
    console.log(`No idle machines found scaling up...`);
    await checkAndScaleUp();

    // Wait for an idle machine to become available
    const start = Date.now();

    while(Date.now() - start < INSTANCE_WAIT_TIMEOUT){
        idleMachines = await getIdleMachines();

        if(idleMachines.length > 0){
            console.log(`Successfully scaled up and found an idle machine`);
            return { instanceId : idleMachines[0]?.InstanceId ?? null}
        }
        
        // Sleep before next check
        await new Promise(res => setTimeout(res, POLL_INTERVAL));
    }
    console.error(`No idle machines within instance wait timeout seems like max instance limit reached`);
    return { instanceId : null }
}

export const vmBootingSetup = async (
    projectId : string, 
    projectName : string, 
    projectType : ProjectTypeValue, 
    ownerId : string
) => {

    await updateVmState(projectId, ownerId, "BOOTING");
    try{
        // 1. Check if that user already have a VM assigned ( this will return it's ID )
        const exisitingVmId = await redis.get(`user:${ownerId}:instance`);

        if(exisitingVmId){
            const existingVmMetaData = await redis.hgetall(`instance:${exisitingVmId}`);

            if(!existingVmMetaData || Object.keys(existingVmMetaData).length === 0){
                await redis.del(`user:${ownerId}:instance`);
            }
            else if(!existingVmMetaData.projectId){
                await redis.multi()
                    .del(`user:${ownerId}:instance`)
                    .del(`instance:${exisitingVmId}`)
                    .exec()
            }
            else if(
                existingVmMetaData.projectId === projectId &&
                existingVmMetaData.publicIP &&
                existingVmMetaData.containerName
            ){
                await updateVmState(projectId, ownerId, "RUNNING");
                return{
                    userId : ownerId,
                    instanceId: exisitingVmId,
                    publicIP: existingVmMetaData.publicIP,
                    projectId,
                    projectName: existingVmMetaData.projectName ?? projectName,
                    projectType: existingVmMetaData.projectType as ProjectTypeValue ?? projectType,
                    containerName: existingVmMetaData.containerName
                }
            }
            else{
                await cleanUpOwnedProjectInstance(existingVmMetaData.projectId, ownerId);
            }
        }
        
        // 2. Get an idle instance
        const allocation = await allocateVmAndScaleUp();

        if(!allocation.instanceId){
            updateVmState(projectId, ownerId, "FAILED")
            return null;
        }

        const instanceId = allocation.instanceId;

        // 3. Get its public IP
        const publicIP   = await getPublicIP(instanceId);
        if(!publicIP){
            console.error(`Failed to fetch public IP for instance ${instanceId}`);
            await terminateAndScaleDown(instanceId,true); // rollback
            await updateVmState(projectId,ownerId,"FAILED")
            return null;
        }

        
        // 4. Start my-code-server container inside VM
        let containerName;
        try{
            const startContainer = await axios.post(`http://${publicIP}:3000/start`,{
                projectId, 
                projectName, 
                projectType 
            })
            containerName = startContainer.data.conatinerName ?? startContainer.data.containerName;

            if(!containerName){
                throw new Error(`Container name missing in start response`)
            }
        }
        catch(err:unknown){
            if(err instanceof Error){
                console.error(`Unable to start container inside instance ${instanceId} ${err.message}`);
            }
            await terminateAndScaleDown(instanceId,true); // rollback if container does not starts
            await updateVmState(projectId,ownerId,"FAILED")
            return null;
        }
        
        
        console.log(containerName);

        // 5. Mark instance:${instanceId} key in redis
        await markInstanceInUse(ownerId, instanceId, projectId, projectName, projectType, publicIP, containerName);
    
        await updateVmState(projectId, ownerId, "RUNNING");

        return {
            userId: ownerId,
            instanceId,
            publicIP,
            projectId,
            projectName,
            projectType,
            containerName
        }
    }
    catch(err){
        updateVmState(projectId, ownerId, "FAILED");
        throw err;
    }
}

export const heartBeat = async () => {
    
    const instances = await redis.keys("instance:*");
    console.log(`Heartbeat check for ${instances.length} instances...`);

    for(const instance of instances){
        const instanceMetaData = await redis.hgetall(instance);

        const containerName = instanceMetaData.containerName;
        const publicIP      = instanceMetaData.publicIP;
        const projectId     = instanceMetaData.projectId;
        const instanceId    = instanceMetaData.instanceId;

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
                console.error(`Heath check request failed for ${instanceId}: ${err.message}`);
                shouldTerminate = true;
            }
        }

        if(shouldTerminate){
            console.log(`Cleaning up unhealthy instance ${instanceId}...`);

            const project = await prisma.project.findUnique({
                where: {
                    id : projectId,
                },
                select: {
                    ownerId: true
                }
            })

            if(!project){
                console.error(`Skipping cleanup for projectId ${projectId} project not found in DB`);
                continue;
            }
            await cleanUpOwnedProjectInstance(projectId, project.ownerId);
        }  
    }
}

