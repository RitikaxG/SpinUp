import { DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand, TerminateInstanceInAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling"
import { asgClient } from "./asgClient";

export const getASGInstances = async () => {
   
    const command = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames : [
            "mycoderserver-asg"
        ]
    });

    const response = await asgClient.send(command);
    const allInstances = response.AutoScalingGroups?.[0]?.Instances || [];
    console.log(allInstances);
    return allInstances;
}

export const getDesiredCapacity = async () => {
    const command = new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames : [
            "mycodeserver-asg"
        ]
    })
    const response = await asgClient.send(command);
    const desiredCapacity = response.AutoScalingGroups?.[0]?.DesiredCapacity || 0;
    return desiredCapacity;
}

export const setDesiredCapacity = async (desiredCapacity : number) => {

    const command = new SetDesiredCapacityCommand({
    AutoScalingGroupName : "mycodeserver-asg",
    DesiredCapacity : desiredCapacity,
    HonorCooldown : false
    })
    const response = await asgClient.send(command);
    return response;
}

export const terminateAndScaleDown = async (instanceId : string, shouldDecreaseCapacity : boolean) => {
    const command = new TerminateInstanceInAutoScalingGroupCommand({
        InstanceId : instanceId,
        ShouldDecrementDesiredCapacity : shouldDecreaseCapacity
    })
    const response = await asgClient.send(command);
    return response;
}

getASGInstances();
