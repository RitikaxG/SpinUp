import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { ec2Client } from "./asgClient";

export const getPublicIP = async (instanceId : string) => {
    const command = new DescribeInstancesCommand({
        InstanceIds : [
            instanceId
        ]
    })
    const response = await ec2Client.send(command);
    const publicIP = response.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
    return publicIP || "";
}

// getPublicIP("i-0f88e2fea824a2ed6");