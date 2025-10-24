import path from "path";
import fs from "fs";
import mime from "mime-types"; // Use mime to get the content type
import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

// Return base-app path
const basePath = path.resolve("base-app");
console.log(basePath);

// Returns all files present in a dir
function getAllFilePaths(dir: string){
    const EXCLUDE = new Set([
    "node_modules",
    ".next",
    "dist",
    "build",
    ".env",
    ".git",
    ".DS_Store"
])
    // Store all file paths
    let files : string[] = [];

    // Returns list of all files and folders in dir
    const items = fs.readdirSync(dir);
    for( const item of items ){
        
        // Exclude node_modules..
        if(EXCLUDE.has(item)) continue;
        // Path of subfolder/file
        const fullPath = path.join(dir,item);
        // Whether item is a file or folder
        const stat = fs.statSync(fullPath);
        if(stat.isDirectory()){
            files = files.concat(getAllFilePaths(fullPath))
        }
        else{
            files.push(fullPath);
        }
    }
    return files;
}

console.log(getAllFilePaths(basePath));

const ACCESS_KEY_ID = process.env.AWS_S3_USER_ACCESS_KEY as string;
const ACCESS_KEY_SECRET = process.env.AWS_S3_USER_SECRET_ACCESS as string;

if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
  throw new Error("AWS credentials are missing. Check your .env file.");
}

// Initialising an S3 Client
const s3Client = new S3Client({
    region : "ap-south-1",
    credentials : {
        accessKeyId : ACCESS_KEY_ID!,
        secretAccessKey : ACCESS_KEY_SECRET!
    }
})

// Ensure bucket "bolt-app" exists if not create one
async function ensureBucketExits(bucketName : string){
    try{
        const command = new HeadBucketCommand({
            Bucket : bucketName
        })

        await s3Client.send(command);
        console.log(`Bucket ${bucketName} already exists`)
    }
    catch(err:any){
        if(err.name === "NotFound" || err.$metadata?.httpStatusCode === 404){
            console.log(`Bucket ${bucketName} does not exists. Creating...`);

            const command = new CreateBucketCommand({
                Bucket : bucketName,
                CreateBucketConfiguration : {
                    LocationConstraint : "ap-south-1"
                }
            })

            await s3Client.send(command);
            console.log(`Bucket ${bucketName} created`);
        }
        else{
            console.error("Error searching for bucket");
        }
    }
}


// Upload all files one by one to S3 "bolt-app" bucket
async function uploadFilesToS3(){
    const allFilePaths = getAllFilePaths(basePath);

    await ensureBucketExits("bolt-app-v2");

    for(const filePath of allFilePaths){
        
        const contentType = mime.lookup(filePath) || "application/octet-stream";
        const fileContent = fs.readFileSync(filePath);

        // Returns the relative path from basePath to the file.
        const relativeFilePath = path.relative(basePath,filePath);
        const s3Key = `base-app/${relativeFilePath}`;

        const command = new PutObjectCommand({
            Bucket : "bolt-app-v2",
            Key : s3Key,
            ContentType : contentType,
            Body : fileContent
        })

       await s3Client.send(command);
    }
}

uploadFilesToS3();



