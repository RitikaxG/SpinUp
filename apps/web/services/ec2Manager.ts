import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import { getPublicIP } from "../lib/aws/ec2Commands";
import { ensureIdleCapacityForAllocation, getIdleMachines } from "./asgManager"
import { cleanUpOwnedProjectInstance, redis, getInstanceIdForUser, getInstanceIdForProject, getInstance, deleteInstanceLifecycle, deleteInstanceMappings, deleteInstanceRecord, writeRunningInstance, writeBootingInstance, updateInstanceHeartbeat, cleanupProjectRuntimeAssignment } from "./redisManager";
import axios from "axios";
import { prisma } from "db/client";
import { markProjectBooting, markProjectFailed, markProjectReady, patchProjectLifecycle, touchProjectHeartbeat } from "./projectLifecycleManager";

const INSTANCE_WAIT_TIMEOUT = 180_000;
const POLL_INTERVAL = 5000;

type ProjectTypeValue = "NEXTJS"| "REACT" | "REACT_NATIVE"
type VmStateValue = "RUNNING" | "STOPPED" | "FAILED" | "TERMINATING" | "BOOTING";

export type RuntimeAssignment = {
    userId : string,
    instanceId : string,
    publicIP : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue,
    containerName : string,
};

const buildContainerName = (projectId : string) => `spinup-${projectId}`;

const toRunningAssignment = (
    ownerId : string,
    projectId : string,
    projectName : string,
    projectType : ProjectTypeValue,
    instanceId : string,
    publicIP : string,
    containerName : string,
) : RuntimeAssignment => ({
    userId : ownerId,
    instanceId,
    publicIP,
    projectId,
    projectName,
    projectType,
    containerName,
});

const isReusableRunningInstance = (
    ownerId : string,
    projectId : string,
    record : Awaited<ReturnType<typeof getInstance>>
) => {
    return Boolean(
        record &&  
        record.userId === ownerId &&
        record.projectId === projectId &&
        record.publicIP &&
        record.containerName &&
        record.status === "RUNNING"
    );
}

const updateProjectRoomVmState = async (
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
   
    console.log(`No idle machines found. Ensuring idle capacity..`);
    const scalingDecision = await ensureIdleCapacityForAllocation();
    console.log(`Allocation scaling decision: ${scalingDecision.action} - ${scalingDecision.reason}`);


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

export const ensureProjectRuntime = async (
    projectId : string, 
    projectName : string, 
    projectType : ProjectTypeValue, 
    ownerId : string
) : Promise<RuntimeAssignment | null> => {

    await updateProjectRoomVmState(projectId, ownerId, "BOOTING");
    
    try{
        // 1) Reconcile project mapping first
        const existingProjectVmId = await getInstanceIdForProject(projectId);

        if(existingProjectVmId){
            const existingProjectVm = await getInstance(existingProjectVmId);

            if(!existingProjectVm){
                await deleteInstanceMappings({
                    projectId,
                })
                await deleteInstanceRecord(existingProjectVmId);
            }
            else if(isReusableRunningInstance(ownerId,projectId, existingProjectVm)){
                await writeRunningInstance({
                    instanceId: existingProjectVm.instanceId,
                    userId: existingProjectVm.userId,
                    projectId: existingProjectVm.projectId,
                    projectName: existingProjectVm.projectName ?? projectName,
                    projectType: existingProjectVm.projectType as ProjectTypeValue ?? projectType,
                    publicIP: existingProjectVm.publicIP,
                    containerName: existingProjectVm.containerName
                })

                await markProjectReady(projectId,{
                    instanceId: existingProjectVm.instanceId,
                    publicIp: existingProjectVm.publicIP,
                    containerName: existingProjectVm.containerName,
                    bootCompletedAt: new Date(),
                })
                await updateProjectRoomVmState(projectId, ownerId, "RUNNING");
            
            
                return toRunningAssignment(
                    ownerId,
                    projectId,
                    projectName,
                    projectType,
                    existingProjectVm.instanceId,
                    existingProjectVm.publicIP,
                    existingProjectVm.containerName,
                )
            }
            else{
                await cleanupProjectRuntimeAssignment(projectId, ownerId);
            }
        }

        // 2) Reconcile user mapping next
        const existingUserVmId = await getInstanceIdForUser(ownerId);
        if(existingUserVmId){
            const existingUserVm = await getInstance(existingUserVmId);

            if(!existingUserVm){
                await deleteInstanceMappings({
                    userId: ownerId,
                })
                await deleteInstanceRecord(existingUserVmId);
            }
            else if(isReusableRunningInstance(ownerId, projectId,existingUserVm)){
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

                await markProjectReady(projectId,{
                    instanceId: existingUserVm.instanceId,
                    publicIp: existingUserVm.publicIP,
                    containerName: existingUserVm.containerName,
                    bootCompletedAt: new Date(),
                })
                await updateProjectRoomVmState(projectId, ownerId, "RUNNING");

                return toRunningAssignment(
                    ownerId,
                    projectId,
                    projectName,
                    projectType,
                    existingUserVm.instanceId,
                    existingUserVm.publicIP,
                    existingUserVm.containerName
                )
            }
            else if(existingUserVm.projectId){
                await cleanupProjectRuntimeAssignment(existingUserVm.projectId, ownerId);
            }
            else{
                await deleteInstanceMappings({ userId: ownerId });
                await deleteInstanceRecord(existingUserVm.instanceId);
            }
        }
        
        
        // 3) Allocate fresh VM
        const allocation = await allocateVmAndScaleUp();

        if(!allocation.instanceId){
            await updateProjectRoomVmState(projectId, ownerId, "FAILED");
            await markProjectFailed(projectId,"No idle machine available within wait timeout");
            return null;
        }

        const instanceId = allocation.instanceId;

       // 4) Fetch public IP
        const publicIP   = await getPublicIP(instanceId);
        if(!publicIP){
            console.error(`Failed to fetch public IP for instance ${instanceId}`);

            try{
                await terminateAndScaleDown(instanceId,true); 
            } catch(err){
                if(err instanceof Error){
                    console.error(`Rollback terminate failed for ${instanceId}: ${err.message}`);
                }
            } finally {
                await updateProjectRoomVmState(projectId,ownerId,"FAILED")
            }

            await updateProjectRoomVmState(projectId, ownerId, "FAILED");
            await markProjectFailed(
                projectId,
                `Failed to fetch public IP for instance ${instanceId}`,
                {
                assignedInstanceId: null,
                publicIp: null,
                containerName: null,
                },
            );
        }

         // 5) Persist BOOTING redis state
        await writeBootingInstance({
            instanceId,
            userId: ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
        })
        
        const bootStartedAt = new Date();

        await markProjectBooting(projectId,{
            instanceId,
            publicIp: publicIP,
            bootStartedAt,
        })

        // 6) Start deterministic container
        let containerName = buildContainerName(projectId);

        try{
             const startContainer = await axios.post(`http://${publicIP}:3000/start`,{
                projectId, 
                projectName, 
                projectType ,
                containerName
            },{
                timeout : 15_000,
            });

            containerName = startContainer.data.conatinerName ?? startContainer.data.containerName ?? containerName;

            // Persist container name as soon as we know it.
            await patchProjectLifecycle(projectId, {
                containerName,
            });
        }
        
        catch(err:unknown){
            if(err instanceof Error){
                console.error(`Unable to start container inside instance ${instanceId} ${err.message}`);
            }

            try{
                await terminateAndScaleDown(instanceId,true);
            } catch( terminateErr ){
                if(terminateErr instanceof Error){
                    console.error(
                        `Rollback terminate failed for ${instanceId}: ${terminateErr.message}`,
                    );
                }
            } finally {
                await deleteInstanceLifecycle(instanceId);
            }
            
            await updateProjectRoomVmState(projectId,ownerId,"FAILED");
            await markProjectFailed(projectId,
                `Unable to start container inside instance ${instanceId} ${err instanceof Error ? err.message : "Unknown error"}`
            ,{
                assignedInstanceId: instanceId,
                publicIp: publicIP,
                containerName: null,
            })
            return null;
        }

        // 7. Promote BOOTING -> RUNNING
        await writeRunningInstance({
            instanceId,
            userId: ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
            containerName
        })
        
        await markProjectReady(projectId,{
            instanceId,
            publicIp: publicIP,
            containerName,
            bootCompletedAt: new Date(),
        })

        await updateProjectRoomVmState(projectId, ownerId, "RUNNING");

        return toRunningAssignment(
            ownerId,
            projectId,
            projectName,
            projectType,
            instanceId,
            publicIP,
            containerName,
        )
    }
    catch(err){
        await updateProjectRoomVmState(projectId, ownerId, "FAILED");
        await markProjectFailed(
            projectId,
            err instanceof Error ? err.message : "Unknown VM booting error",
        );
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
            await markProjectFailed(projectId,"Heartbeat recovery cleanup triggered",{
                assignedInstanceId: null,
                containerName: null,
                publicIp: null,
                lastHeartbeatAt: null
            })

            await cleanUpOwnedProjectInstance(projectId, project.ownerId);
            continue;
        }  

        await updateInstanceHeartbeat(instanceId);
        await touchProjectHeartbeat(projectId);
    }
}

