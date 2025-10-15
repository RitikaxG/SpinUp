import { copyS3Folder, listFilesInS3, storeFilesInVM } from "./fetch-base-app-from-s3";
import { uploadFilesToS3 } from "./upload-base-app-to-s3";


export const doesS3PathExist = async (prefix : string) => {
    const response = await listFilesInS3(prefix);
    return ( response.Contents && response.Contents.length > 0 ) || false
}

async function VMBaseSetup(projectId : string, projectName : string, projectType : string){
   
    const sourcePrefix = `base-app/${projectType}-base-app`;
    const destinationPrefix = `projects/${projectName}_${projectId}/code-${projectType}`;

    // If project already exist pull it instead of overwriting
    const projectExists = await doesS3PathExist(destinationPrefix);
    if(projectExists){
        console.log(`Project already exists pulling exisiting files from S3...`);
        await storeFilesInVM(destinationPrefix);
        return;
    }
    
    const baseImageExists = await doesS3PathExist("base-app");
    if(!baseImageExists){
        // Step 1 : Preupload Base App to S3
        await uploadFilesToS3("base-app","base-app");
        console.log(`Successfully pushed base-app to S3`);
    }
        

    // Step 2 : Copy base app of project type from sourcePrefix to destinationPrefix in Bucket
    await copyS3Folder(sourcePrefix,destinationPrefix);
    console.log(`Successfully copied user code files from ${sourcePrefix} to ${destinationPrefix}`);
    
    // Step 3 : Fetch new copy to VM
    await storeFilesInVM(destinationPrefix);
    console.log(`Successfully fetched user's code dir from S3 to VM`);
        
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
