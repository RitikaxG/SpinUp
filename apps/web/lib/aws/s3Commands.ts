import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "./asgClient";

export const deleteS3Object = async (bucketName : string, objectKey : string) => {
    const command = new DeleteObjectCommand({
        Bucket : bucketName,
        Key : objectKey
    })
    const response = await s3Client.send(command);
    return response;
}