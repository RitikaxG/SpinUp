import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { ENV } from "../config/env";

const hasExplicitAccessKey = Boolean(ENV.EC2_LAUNCHER_ACCESS_KEY);
const hasExplicitSecret = Boolean(ENV.EC2_LAUNCHER_ACCESS_SECRET);

if (hasExplicitAccessKey !== hasExplicitSecret) {
  throw new Error(
    "EC2_LAUNCHER_ACCESS_KEY and EC2_LAUNCHER_ACCESS_SECRET must be provided together",
  );
}

if (ENV.AWS_AUTH_MODE === "explicit" && !hasExplicitAccessKey) {
  throw new Error(
    "AWS_AUTH_MODE=explicit requires EC2_LAUNCHER_ACCESS_KEY and EC2_LAUNCHER_ACCESS_SECRET",
  );
}

const sharedAwsConfig =
  hasExplicitAccessKey && hasExplicitSecret
    ? {
        region: ENV.AWS_REGION,
        credentials: {
          accessKeyId: ENV.EC2_LAUNCHER_ACCESS_KEY,
          secretAccessKey: ENV.EC2_LAUNCHER_ACCESS_SECRET,
        },
      }
    : {
        region: ENV.AWS_REGION,
      };

export const asgClient = new AutoScalingClient(sharedAwsConfig);
export const ec2Client = new EC2Client(sharedAwsConfig);
export const s3Client = new S3Client(sharedAwsConfig);