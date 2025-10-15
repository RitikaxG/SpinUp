import chokidar from "chokidar";
import path from "path";
import fs from "fs";
import { uploadFilesToS3 } from "./upload-base-app-to-s3";
import debounce from "lodash.debounce"; // prevents flooding S3
import type { FSWatcher } from "chokidar";


export const startProjectSync = (projectName : string, projectId : string, projectType : string) => {
    const projectPath = `/app/projects/${projectName}_${projectId}/code-${projectType}`;
    const s3Prefix = `projects/${projectName}_${projectId}/code-${projectType}`;

    const watcher = chokidar.watch(projectPath,{
        ignoreInitial : true,
        persistent : true,
        depth : 10
    })
    console.log(`[Watcher] Watching changes in: ${projectPath}`);

    const logFile = path.join(projectPath,"sync.log");
    const log = (msg: string) => {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    };

    const syncFiles = async() =>{
        try{
            await uploadFilesToS3(projectPath,s3Prefix);
            console.log(`[Watcher] Synced: ${projectPath}`);
        }
        catch(err : unknown){
            if(err instanceof Error){
                log(`Error syncing: ${err}`);
                console.error(`[Watcher Error]`, err);
            }
        }
    } 

    const debounceSync =  debounce(syncFiles,3000);
    watcher.on("add",debounceSync)
           .on("change",debounceSync)
           .on("unlink",debounceSync);

    shutDownHandler(watcher, projectPath,s3Prefix, log);

}
    
const shutDownHandler = (watcher : FSWatcher, projectPath : string, s3Prefix : string, log : (msg : string) => void ) => {
    const shutdown = async () => {
    
        watcher.close(); // Stop file watcher
        try {
            await uploadFilesToS3(projectPath,s3Prefix); // Final sync
            console.log("[Shutdown] Final sync done.");
        } catch (err) {
            log(`[Shutdown Error] ${err instanceof Error ? err.message : String(err)}`);
            console.error("[Shutdown Error] Sync failed:", err);
        }
        process.exit(0);
    }

    process.on("SIGINT", shutdown);   // Ctrl+C
    process.on("SIGTERM", shutdown);  // VM stopped
    process.on("exit", (code) => {
        console.log(`[Exit] Process exited with code ${code}`);
    });
    process.on("uncaughtException", (err) => {
        console.error("[Crash] Uncaught exception:", err);
        shutdown();
    })
}

if(require.main === module){
    const [,,projectName, projectId, projectType ] = process.argv;
    if(!projectId || !projectName || !projectType){
        console.error(`projectId, projectName , projectType required`);
        process.exit(1);
    }
    try{
        startProjectSync(projectName, projectId, projectType);
    }
    catch(err){
        if(err instanceof Error){
            console.error(`Error running startProjectSync background job ${err.message}`);
            process.exit(1);
        }
    }
}