import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import { s3Client } from "./asgClient";

export const deleteS3Prefix = async (bucketName: string, prefix: string) => {
  let continuationToken: string | undefined;
  let deletedCount = 0;

  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const objects: ObjectIdentifier[] = (listed.Contents ?? []).flatMap(
      (item) => {
        if (!item.Key) return [];
        return [{ Key: item.Key }];
      },
    );

    if (objects.length > 0) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: objects,
            Quiet: true,
          },
        }),
      );
      deletedCount += objects.length;
    }

    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return { deletedCount, prefix };
};