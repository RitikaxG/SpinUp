import { terminateAndScaleDown } from "../lib/aws/asgCommands";
import { getPublicIP } from "../lib/aws/ec2Commands";
import { ensureIdleCapacityForAllocation, getIdleMachines } from "./asgManager"
import { deleteInstanceLifecycle, cleanupProjectRuntimeAssignment, rehydrateProjectRuntimeRedis, mirrorProjectAssignmentToRedis } from "./redisManager";
import axios from "axios";
import { prisma } from "db/client";
import { markProjectBooting, markProjectFailed, markProjectReady } from "./projectLifecycleManager";
import { ACTIVE_RUNTIME_STATUSES, getProjectRuntimeSnapshot } from "./projectRuntimeTruthSource";

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

// const isReusableRunningInstance = (
//     ownerId : string,
//     projectId : string,
//     record : Awaited<ReturnType<typeof getInstance>>
// ) => {
//     return Boolean(
//         record &&  
//         record.userId === ownerId &&
//         record.projectId === projectId &&
//         record.publicIP &&
//         record.containerName &&
//         record.status === "RUNNING"
//     );
// }



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
        const dbSnapshot = await getProjectRuntimeSnapshot(projectId);
        const dbProject = dbSnapshot.project;

        if(!dbProject){
            throw new Error("Project not found");
        }

        if(
            dbProject.assignedInstanceId &&
            dbProject.publicIp &&
            (dbProject.status === "BOOTING_CONTAINER" || dbProject.status === "READY")
        ){
            await rehydrateProjectRuntimeRedis(projectId);

            if(dbProject.status === "READY" && dbProject.containerName){
                await updateProjectRoomVmState(projectId, ownerId, "RUNNING");

                return toRunningAssignment(
                ownerId,
                dbProject.id,
                dbProject.name,
                dbProject.type,
                dbProject.assignedInstanceId,
                dbProject.publicIp,
                dbProject.containerName ?? "",
                )
            }
            return null;
        }

        const anotherActiveProject = await prisma.project.findFirst({
            where : {
                ownerId,
                id: { not : projectId },
                deletedAt : null,
                status : { in : ACTIVE_RUNTIME_STATUSES },
                assignedInstanceId: { not: null },
            },
            select : {
                id : true,
            }
        })
       
        if(anotherActiveProject){
            await cleanupProjectRuntimeAssignment(anotherActiveProject.id, ownerId);
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
                await deleteInstanceLifecycle(instanceId);
            }

            await updateProjectRoomVmState(projectId, ownerId, "FAILED");
            await markProjectFailed(
                projectId,
                `Failed to fetch public IP for instance ${instanceId}`,
                {
                assignedInstanceId: null,
                publicIp: null,
                containerName: null,
                lastHeartbeatAt: null,
                },
            );
            return null;
        }
        
        const bootStartedAt = new Date();

        await markProjectBooting(projectId,{
            instanceId,
            publicIp: publicIP,
            bootStartedAt,
        })

        await mirrorProjectAssignmentToRedis({
            instanceId,
            userId : ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
            containerName : "",
            status : "BOOTING",
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

            containerName = startContainer.data.containerName ?? containerName;
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
                assignedInstanceId: null,
                publicIp: null,
                containerName: null,
                lastHeartbeatAt: null,
            })
            return null;
        }
        
        await markProjectReady(projectId,{
            instanceId,
            publicIp: publicIP,
            containerName,
            bootCompletedAt: new Date(),
        });

        await mirrorProjectAssignmentToRedis({
            instanceId,
            userId: ownerId,
            projectId,
            projectName,
            projectType,
            publicIP,
            containerName,
            status: "RUNNING",
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
            {
                assignedInstanceId: null,
                publicIp: null,
                containerName: null,
                lastHeartbeatAt: null,
            }
        );
        throw err;
    }
}


