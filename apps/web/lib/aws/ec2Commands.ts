import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { ec2Client } from "./asgClient";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const getPublicIP = async (instanceId: string) => {
  const command = new DescribeInstancesCommand({
    InstanceIds: [instanceId],
  });

  const response = await ec2Client.send(command);
  const publicIP = response.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
  return publicIP || "";
};

export const waitForPublicIP = async (
  instanceId: string,
  timeoutMs = 60_000,
  pollIntervalMs = 2_000,
) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const publicIP = await getPublicIP(instanceId);
    if (publicIP) {
      return publicIP;
    }

    await sleep(pollIntervalMs);
  }

  return "";
};