import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";


const EC2_LAUNCHER_ACCESS_KEY = process.env.EC2_LAUNCHER_ACCESS_KEY as string;
const EC2_LAUNCHER_ACCESS_SECRET = process.env.EC2_LAUNCHER_ACCESS_SECRET as string;

if(!EC2_LAUNCHER_ACCESS_KEY || !EC2_LAUNCHER_ACCESS_SECRET){
    console.error(`AWS credentials missing in ec2.ts`);
}

export const asgClient = new AutoScalingClient({
    region : 'ap-south-1',
    credentials : {
        accessKeyId : EC2_LAUNCHER_ACCESS_KEY,
        secretAccessKey : EC2_LAUNCHER_ACCESS_SECRET
    }
})

export const ec2Client = new EC2Client({
    region : 'ap-south-1',
    credentials : {
        accessKeyId : EC2_LAUNCHER_ACCESS_KEY,
        secretAccessKey : EC2_LAUNCHER_ACCESS_SECRET
    }
})

export const s3Client = new S3Client({
    region : "ap-south-1"
})