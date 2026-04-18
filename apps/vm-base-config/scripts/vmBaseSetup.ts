import { copyS3Folder, listFilesInS3, storeFilesInVM } from "./fetch-base-app-from-s3";
import { uploadFilesToS3 } from "./upload-base-app-to-s3";
import { promises as fs } from "fs";


export const doesS3PathExist = async (prefix : string) => {
    const response = await listFilesInS3(prefix);
    return ( response.Contents && response.Contents.length > 0 ) || false
}

async function VMBaseSetup(projectId: string, projectName: string, projectType: string) {
  const sourcePrefix = `base-app/${projectType}-base-app`;
  const destinationPrefix = `projects/${projectName}_${projectId}/code-${projectType}`;

  const projectExists = await doesS3PathExist(destinationPrefix);
  if (projectExists) {
    console.log(`Project already exists pulling existing files from S3...`);
    const result = await storeFilesInVM(destinationPrefix);
    await fs.access(result.outputRoot);
    console.log(
      `Successfully fetched existing project from S3 to VM. files=${result.writtenCount} root=${result.outputRoot}`,
    );
    return;
  }

  const baseImageExists = await doesS3PathExist("base-app");
  if (!baseImageExists) {
    await uploadFilesToS3("base-app", "base-app");
    console.log(`Successfully pushed base-app to S3`);
  }

  await copyS3Folder(sourcePrefix, destinationPrefix);
  console.log(`Successfully copied user code files from ${sourcePrefix} to ${destinationPrefix}`);

  const result = await storeFilesInVM(destinationPrefix);
  await fs.access(result.outputRoot);

  console.log(
    `Successfully fetched user's code dir from S3 to VM. files=${result.writtenCount} root=${result.outputRoot}`,
  );
}

// if (require.main === module) guard (ensures it's being executed directly, not imported)
if(require.main === module){
    const [ ,,projectId, projectName, projectType ] = process.argv;
    if(!projectId || !projectName || !projectType){
        console.error(`projectId, projectType, projectName required`);
        process.exit(1);
    }
    try{
        await VMBaseSetup(projectId, projectName, projectType);
    }
    catch(err){
        if(err instanceof Error){
            console.error(`Error configuring VMBaseSetup ${err.message}`);
            process.exit(1);
        }
    }
}
