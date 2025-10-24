import { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import path from "path";
import { promises as fs } from 'fs';

// const ACCESS_KEY_ID=process.env.AWS_S3_USER_ACCESS_KEY as string;
// const ACCESS_KEY_SECRET=process.env.AWS_S3_USER_SECRET_ACCESS as string;
const S3_BUCKET_NAME="bolt-app-v2";

// if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET || !S3_BUCKET_NAME) {
//   throw new Error("AWS credentials are missing. Check your .env file.");
// }

// Initialising an S3 Client
const s3Client = new S3Client({
    region : "ap-south-1",
    // credentials : {
    //     accessKeyId : ACCESS_KEY_ID!,
    //     secretAccessKey : ACCESS_KEY_SECRET!
    // }
})

// ListFiles inside an object in S3
export async function listFilesInS3(sourcePrefix: string, continuationToken? : string){
    const command = new ListObjectsV2Command({
        Bucket : S3_BUCKET_NAME,
        Prefix : sourcePrefix,
        ContinuationToken : continuationToken
    })
    const response = await s3Client.send(command);
    return response;
}

async function getFilesFromS3(key : string){
    const command = new GetObjectCommand({
        Bucket : S3_BUCKET_NAME,
        Key : key
    })

    const response = await s3Client.send(command);
    return response;
}

// 
const getBody = (response: GetObjectCommandOutput) => {
  return response.Body && (response.Body as Readable);
};

const getBodyAsBuffer = async (response: GetObjectCommandOutput) => {
  const stream = getBody(response);
  if (stream) {
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
};

const getBodyAsString = async (response: GetObjectCommandOutput) => {
  const buffer = await getBodyAsBuffer(response);
  return buffer?.toString();
};

// Fetch and store files from S3
export async function storeFilesInVM(sourcePrefix: string){
    const basePath = path.resolve(process.cwd());
    try{
        const response = await listFilesInS3(sourcePrefix);
        if(response.Contents){
            await Promise.all(response.Contents.map(async (file) => {
                const fileKey = file.Key;
                if(fileKey && !fileKey.endsWith("/")){
                    const data = await getFilesFromS3(fileKey);
                    if(data.Body){
                        const fileData = await getBodyAsString(data);
                        
                        const filePath = path.join(basePath,fileKey);
                        
                        // If filePath doesn't exist create it
                        await fs.mkdir(path.dirname(filePath), { recursive: true });

                        await fs.writeFile(filePath,fileData!);
                        console.log(`File contents successfully written`);
                        
                    }
                }
            }))
        }
    }
    catch(err){
        console.error(`Error fetching files from S3`);
    }
}


async function copyObjectsInS3(objectKey: string, destinationKey : string){
    const command = new CopyObjectCommand({
        Bucket : S3_BUCKET_NAME,
        CopySource : `${S3_BUCKET_NAME}/${objectKey}`,
        Key : destinationKey
    })

    await s3Client.send(command);
}


export async function copyS3Folder(sourcePrefix : string, destinationPrefix : string, continuationToken? : string) : Promise<void>{
    try{
        const listedObjects = await listFilesInS3(sourcePrefix, continuationToken);

        if(!listedObjects.Contents || listedObjects.Contents.length === 0) return;
        await Promise.all(listedObjects.Contents.map(async(object) => {
            if(!object.Key) return;

            const destinationKey = object.Key.replace(sourcePrefix, destinationPrefix);
            await copyObjectsInS3(object.Key, destinationKey);

            console.log(`Copied file from ${sourcePrefix} to ${destinationPrefix}`);
        }))

        if(listedObjects.IsTruncated){
            continuationToken = listedObjects.NextContinuationToken;
            await copyS3Folder(sourcePrefix, destinationPrefix, continuationToken);
        }
    }
    catch(err : any){
        console.error(`Error copying folder in S3 ${err.message}`);
    }
}   

