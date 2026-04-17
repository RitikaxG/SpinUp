# vm-base-config

## Overview
`vm-base-config` is the project-aware workspace image and bootstrap layer for SpinUp. It is built on top of `lscr.io/linuxserver/code-server:latest`, installs Node.js 22 and Bun, copies my setup scripts into `/app`, and starts everything through `/app/entrypoint.sh`. The container exposes port 8080 and launches code-server from inside the container. 

## Why this package exists
A plain code-server image only gives a browser IDE. SpinUp needs much more than that:
- seed a fresh workspace from a reusable base app,
- persist project files across restarts,
- sync changes back to object storage,
- enable collaboration tooling,
- and make startup deterministic for every project type.

`vm-base-config` is the layer that turns a generic code-server container into a **SpinUp workspace runtime**.

## What it provides

### 1. Base app bootstrapping from S3
`vmBaseSetup.ts` builds two key prefixes:
- source: `base-app/${projectType}-base-app`
- destination: `projects/${projectName}_${projectId}/code-${projectType}`

If the destination already exists in S3, it pulls the existing project into the VM. Otherwise it:
1. ensures the base app is uploaded,
2. copies the project-type base app inside the bucket,
3. fetches that copied project into the VM. 

### 2. Pre-upload of the base app
`upload-base-app-to-s3.ts` recursively walks the local folder, skips heavy/unwanted paths such as `node_modules`, `.next`, `dist`, `build`, `.env`, `.git`, and `.DS_Store`, ensures the bucket exists, and uploads files with MIME types preserved. The bucket name is currently hardcoded as `bolt-app-v2`. 

### 3. Copy-on-create project provisioning
`fetch-base-app-from-s3.ts` supports listing objects, copying objects within the same S3 bucket, and fetching objects back down to the VM filesystem. `copyS3Folder(...)` is what turns a reusable base-app prefix into a project-specific prefix like `projects/${projectName}_${projectId}/code-${projectType}`. 

### 4. Pulling project files into the VM
`storeFilesInVM(...)` downloads each object under the project prefix and writes it into the container filesystem, preserving directory structure under `/app/projects/...`. That is what makes a project visible to code-server as real files on disk.

### 5. Periodic / event-driven sync back to S3
`startProjectSync.ts` watches `/app/projects/${projectName}_${projectId}/code-${projectType}` with `chokidar`, debounces rapid file changes by 3 seconds, uploads the changed project tree back to S3, writes a `sync.log`, and performs a final sync on shutdown signals such as `SIGINT` and `SIGTERM`.

### 6. CodeTogether support
`entrypoint.sh` installs the CodeTogether extension from `/app/extensions/codetogether.vsix` before launching code-server. 

### 7. Default code-server theme
`entrypoint.sh` writes user settings under `/config/.local/share/code-server/User/settings.json` and sets the default theme to `Default Dark+`. 

### 8. Containerized startup on port 8080
The entrypoint runs this sequence:
1. `bun scripts/vmBaseSetup.ts`
2. `bun install` inside the project directory
3. install CodeTogether extension
4. launch background sync watcher
5. set the default theme
6. exec code-server on `0.0.0.0:8080` with `--auth none`

## File map
- `docker/Dockerfile.codeserver`: builds the workspace image.
- `entrypoint.sh`: orchestrates container startup. 
- `scripts/vmBaseSetup.ts`: decides whether to reuse an existing project, upload the base app, copy it in S3, and fetch it locally. 
- `scripts/upload-base-app-to-s3.ts`: uploads a local folder tree to S3. 
- `scripts/fetch-base-app-from-s3.ts`: list/get/copy/fetch helpers for S3. 
- `scripts/startProjectSync.ts`: background watcher and final sync on shutdown. 

## Local testing vs EC2/ASG runtime

### Local Docker testing: why credentials are required
When we run this image locally on our laptop, the container is **not** running on an EC2 instance with an attached instance profile. The AWS SDK for JavaScript v3 therefore cannot pull credentials from EC2 metadata. Because the S3 clients in this repo are currently initialized with only `region` and their explicit credential block is commented out, the SDK falls back to the default Node.js credential provider chain. That means local runs need credentials from environment variables, shared AWS config files, or another standard provider. 

In practice, local validation uses an IAM user (or equivalent local principal) with enough rights to:
- provision AWS resources if local orchestration code creates EC2 / launch templates / ASGs,
- and access S3 if the container is going to execute `vmBaseSetup` locally.

If we choose to test by uncommenting explicit credentials inside the S3 clients, the container will also work with our custom env names. But the production-friendly version is to rely on the standard credential chain and pass standard `AWS_*` vars locally. 

### EC2 / ASG runtime: why hardcoded credentials are not required
In the EC2 path, the launch template attaches an **instance profile** to the VM. An instance profile is the IAM mechanism used to pass an IAM role to an EC2 instance, and applications on that instance can retrieve temporary credentials through the Instance Metadata Service. For Auto Scaling groups, AWS explicitly expects the role to be associated through the launch template / instance profile. That is why our production image can remove hardcoded AWS keys and still access S3 when it runs on EC2. 

## IAM model for this package

### Local provisioning user
A laptop-side user may need:
- EC2 permissions,
- Auto Scaling permissions,
- S3 permissions for local container testing,
- and `iam:PassRole` if it creates or updates launch templates / ASGs that reference an instance profile. AWS documents that launching instances from a launch template containing an instance profile requires `iam:PassRole`. 

### Runtime EC2 role
The VM’s **runtime** identity should be the EC2 role attached through the launch template. That role needs the S3 permissions required by `vm-base-config` for our bucket and prefixes. The role is what the container should use in AWS; the IAM user should not be “attached” to the EC2 instance. 

## Important operational caveats
- The bucket name is currently hardcoded in both S3 scripts as `bolt-app-v2`; if the bucket changes, rebuild the image after updating both files. 
- `uploadFilesToS3(...)` uploads current files, but the current implementation does not issue S3 deletes for removed files, so `unlink` events do not remove old objects from S3. 
- `ensureBucketExits(...)` logs a generic error for non-404 `HeadBucket` failures instead of surfacing the original exception; improving that will make future debugging easier.

## Summary
`vm-base-config` is the **workspace bootstrap and persistence layer** of SpinUp. It seeds project files from S3, restores existing projects, keeps the VM copy in sync with object storage, installs collaboration tooling, configures code-server, and serves the developer workspace on port 8080.
