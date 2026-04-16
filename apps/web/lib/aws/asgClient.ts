import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { ENV } from "../config/env";

const EC2_LAUNCHER_ACCESS_KEY = ENV.EC2_LAUNCHER_ACCESS_KEY;
const EC2_LAUNCHER_ACCESS_SECRET = ENV.EC2_LAUNCHER_ACCESS_SECRET;
const AWS_REGION = ENV.AWS_REGION;

if (!EC2_LAUNCHER_ACCESS_KEY || !EC2_LAUNCHER_ACCESS_SECRET) {
  console.error("AWS credentials missing in asgClient.ts");
}

export const asgClient = new AutoScalingClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: EC2_LAUNCHER_ACCESS_KEY,
    secretAccessKey: EC2_LAUNCHER_ACCESS_SECRET,
  },
});

export const ec2Client = new EC2Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: EC2_LAUNCHER_ACCESS_KEY,
    secretAccessKey: EC2_LAUNCHER_ACCESS_SECRET,
  },
});

export const s3Client = new S3Client({
  region: AWS_REGION,
});