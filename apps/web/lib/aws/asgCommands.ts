import { DescribeAutoScalingGroupsCommand, DescribeAutoScalingGroupsCommandOutput, SetDesiredCapacityCommand, TerminateInstanceInAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling"
import { asgClient } from "./asgClient";
import { AUTOSCALING_CONFIG } from "../autoscaling/config";

type AutoScalingGroup = NonNullable<DescribeAutoScalingGroupsCommandOutput["AutoScalingGroups"]>[number];

export type AutoScalingInstanceDetails = NonNullable<AutoScalingGroup["Instances"]>[number];

export type AutoScalingGroupState = {
    groupName: string,
    desiredCapacity: number,
    minSize: number,
    maxSize: number,
    instances : AutoScalingInstanceDetails[],
    totalInstances: number,
}

const getConfiguredAsgName = () => AUTOSCALING_CONFIG.ASG_NAME;

export const getAutoScalingGroup = async() : Promise<AutoScalingGroup> => {
    const command = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [getConfiguredAsgName()],
    })

    const response = await asgClient.send(command);
    const group = response.AutoScalingGroups?.[0];

    if(!group){
        throw new Error(`Autoscaling group ${getConfiguredAsgName()} not found.`)
    }

    return group;
}

export const getAutoScalingGroupState = async() : Promise<AutoScalingGroupState> => {
    const group = await getAutoScalingGroup();

    const instances = group.Instances ?? [];
    const desiredCapacity = group.DesiredCapacity ?? 0;
    const minSize = group.MinSize ?? 0;
    const maxSize = group.MaxSize ?? AUTOSCALING_CONFIG.MAX_TOTAL_INSTANCES;
    const groupName = group.AutoScalingGroupName ?? getConfiguredAsgName();

    return {
        groupName,
        desiredCapacity,
        minSize,
        maxSize,
        instances,
        totalInstances : instances.length
    }

}
export const getASGInstances = async (): Promise<AutoScalingInstanceDetails[]> => {
   const state = await getAutoScalingGroupState();
   return state.instances;
}

export const getDesiredCapacity = async () => {
    const state = await getAutoScalingGroupState();
    return state.desiredCapacity;
}

// Give me target, but if it is too small, use minSize, and if it is too large, use boundedMax
const clampDesiredCapacity = (
    target : number,
    minSize : number,
    maxSize : number,
) => {
    const boundedMax = Math.min(
        maxSize,
        AUTOSCALING_CONFIG.MAX_TOTAL_INSTANCES
    )

    return Math.max(minSize, Math.min(target, boundedMax)); // [ minSize, boundedMax ]
}

export const setDesiredCapacity = async (desiredCapacity : number) => {

    const command = new SetDesiredCapacityCommand({
    AutoScalingGroupName : AUTOSCALING_CONFIG.ASG_NAME,
    DesiredCapacity : desiredCapacity,
    HonorCooldown : false
    })
    const response = await asgClient.send(command);
    return response;
}

export const setDesiredCapacityIfChanged = async ( target: number) => {
    const state = await getAutoScalingGroupState();
    const safeTarget = clampDesiredCapacity(target, state.minSize, state.maxSize);

    if(safeTarget === state.desiredCapacity){
        return {
            changed : false,
            previousDesiredCapacity : state.desiredCapacity,
            desiredCapacity : state.desiredCapacity,
            groupName: state.groupName,
        }
    }

    await setDesiredCapacity(safeTarget);

    return {
        changed : true,
        previousDesiredCapacity : state.desiredCapacity,
        desiredCapacity : safeTarget,
        groupName : state.groupName
    }
}

export const terminateAndScaleDown = async (instanceId : string, shouldDecreaseCapacity : boolean) => {
    const command = new TerminateInstanceInAutoScalingGroupCommand({
        InstanceId : instanceId,
        ShouldDecrementDesiredCapacity : shouldDecreaseCapacity
    })
    const response = await asgClient.send(command);
    return response;
}

export const terminateAndReplace = async (instanceId: string) => {
  return terminateAndScaleDown(instanceId, false);
};


