import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import { getPublicIP } from "../lib/aws/ec2Commands";
import { checkAndScaleUp, getIdleMachines } from "./asgManager"
import { cleanUpOwnedProjectInstance, redis, getInstanceIdForUser, getInstanceIdForProject, getInstance, deleteInstanceLifecycle, deleteInstanceMappings, deleteInstanceRecord, writeRunningInstance, writeBootingInstance, updateInstanceHeartbeat } from "./redisManager";
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
        const existingProjectVmId = await getInstanceIdForProject(projectId);

        if(existingProjectVmId){
            const existingProjectVm = await getInstance(existingProjectVmId);

            if(!existingProjectVm){
                await deleteInstanceMappings({
                    projectId,
                })
                await deleteInstanceRecord(existingProjectVmId);
            }
            else if(
                existingProjectVm.userId === ownerId &&
                existingProjectVm.projectId === projectId &&
                existingProjectVm.publicIP &&
                existingProjectVm.containerName &&
                existingProjectVm.status === "RUNNING"
            ){
                await writeRunningInstance({
                    instanceId: existingProjectVm.instanceId,
                    userId: existingProjectVm.userId,
                    projectId: existingProjectVm.projectId,
                    projectName: existingProjectVm.projectName ?? projectName,
                    projectType: existingProjectVm.projectType as ProjectTypeValue ?? projectType,
                    publicIP: existingProjectVm.publicIP,
                    containerName: existingProjectVm.containerName
                })

                await updateVmState(projectId, ownerId, "RUNNING");
            
            
                return{
                    userId : ownerId,
                    instanceId: existingProjectVm.instanceId,
                    publicIP: existingProjectVm.publicIP,
                    projectId,
                    projectName: existingProjectVm.projectName ?? projectName,
                    projectType: existingProjectVm.projectType as ProjectTypeValue ?? projectType,
                    containerName: existingProjectVm.containerName
                }
            }
            else{
                await cleanUpOwnedProjectInstance(projectId, ownerId);
            }
        }

        // Check if user is mapped to some other instance
        const existingUserVmId = await getInstanceIdForUser(ownerId);
        if(existingUserVmId){
            const existingUserVm = await getInstance(existingUserVmId);

            if(!existingUserVm){
                await deleteInstanceMappings({
                    userId: ownerId,
                })
                await deleteInstanceRecord(existingUserVmId);
            }
            else if(
                existingUserVm.projectId === projectId &&
                existingUserVm.publicIP &&
                existingUserVm.containerName &&
                existingUserVm.status === "RUNNING"
            ){
                // Heal project mapping if user mapping exists but project mapping is stale
                await writeRunningInstance({
                    instanceId: existingUserVm.instanceId,
                    userId: existingUserVm.userId,
                    projectId: existingUserVm.projectId,
                    projectName: existingUserVm.projectName ?? projectName,
                    projectType: existingUserVm.projectType as ProjectTypeValue ?? projectType,
                    publicIP: existingUserVm.publicIP,
                    containerName: existingUserVm.containerName
                })

                await updateVmState(projectId, ownerId, "RUNNING");

                return{
                    userId : ownerId,
                    instanceId: existingUserVm.instanceId,
                    publicIP: existingUserVm.publicIP,
                    projectId: existingUserVm.projectId,
                    projectName: existingUserVm.projectName ?? projectName,
                    projectType: existingUserVm.projectType as ProjectTypeValue ?? projectType,
                    containerName: existingUserVm.containerName
                }
            }
            else if(existingUserVm.projectId){
                await cleanUpOwnedProjectInstance(existingUserVm.projectId, ownerId);
            }
            else{
                await deleteInstanceMappings({projectId});
                await deleteInstanceRecord(existingUserVm.instanceId);
            }
        }
        
        
        // 2. Get a fresh idle instance
        const allocation = await allocateVmAndScaleUp();

        if(!allocation.instanceId){
            await updateVmState(projectId, ownerId, "FAILED")
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

        await writeBootingInstance({
            instanceId,
            userId: ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
        })
        
        // 4. Start my-code-server container inside VM
        let containerName: string;
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
            await deleteInstanceLifecycle(instanceId);
            await updateVmState(projectId,ownerId,"FAILED")
            return null;
        }

        // Promote BOOTING -> RUNNING
        await writeRunningInstance({
            instanceId,
            userId: ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
            containerName
        })
        
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
        await updateVmState(projectId, ownerId, "FAILED");
        throw err;
    }
}

export const heartBeat = async () => {
    
    const instances = await redis.keys("instance:*");
    console.log(`Heartbeat check for ${instances.length} instances...`);

    for(const instanceKey of instances){
        const instanceId = instanceKey.split(":")[1];

        if (!instanceId) {
        continue;
        }
        const instanceMetaData = await getInstance(instanceId);
        if(!instanceMetaData){
            await deleteInstanceRecord(instanceId);
            continue;
        }

        // Only actively running allocations need container/health checks
        if (instanceMetaData.status !== "RUNNING") {
        continue;
        }

        const containerName = instanceMetaData.containerName;
        const publicIP      = instanceMetaData.publicIP;
        const projectId     = instanceMetaData.projectId;

        if(!containerName || !publicIP || !projectId || !instanceId){
            console.error(`Skipping ${instanceId} : missing data in redis`);

            if (projectId) {
                const project = await prisma.project.findUnique({
                where: { id: projectId },
                select: { ownerId: true },
                });

                if (project) {
                await cleanUpOwnedProjectInstance(projectId, project.ownerId);
                } else {
                await deleteInstanceLifecycle(instanceId);
                }
            } 
            
            else {
                await deleteInstanceLifecycle(instanceId);
            }

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
            const healthCheck = await axios.get(`http://${publicIP}:3000/health`,{
                timeout : 5000
            });
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
                await deleteInstanceLifecycle(instanceId);
                continue;
            }
            await cleanUpOwnedProjectInstance(projectId, project.ownerId);
            continue;
        }  

        await updateInstanceHeartbeat(instanceId);
    }
}

