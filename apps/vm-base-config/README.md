# vm-base-config

`vm-base-config` is the workspace image/bootstrap layer for SpinUp.

It is the Docker image that actually runs the user's code-server workspace on an EC2 VM.

The SpinUp backend does not directly run code-server. The backend asks the VM agent to start a Docker container, and that container is built from this package.

```text
SpinUp backend
  → VM agent starts Docker container
  → vm-base-config bootstraps project files
  → code-server runs on port 8080
```

---

## Why this app exists

A plain code-server image only gives a browser IDE.

SpinUp needs the workspace container to also:

- know which project it belongs to,
- restore existing project files from S3,
- create a new project from a base app if needed,
- install dependencies,
- sync file changes back to S3,
- install collaboration tooling,
- start code-server in the correct project folder.

`vm-base-config` adds that project-aware startup behavior.

---

## What this app does

When the container starts, it receives:

```env
PROJECT_ID=<projectId>
PROJECT_NAME=<projectName>
PROJECT_TYPE=<projectType>
```

Then it runs this flow:

```text
1. Build the project S3 prefix
2. Check whether this project already exists in S3
3. If it exists, download existing files into the container
4. If it does not exist, copy the base app to a project-specific S3 path
5. Download the project files into /app/projects/...
6. Run bun install inside the project
7. Install CodeTogether extension
8. Start file sync watcher
9. Start code-server on 0.0.0.0:8080
```

---

## S3 layout

The container uses two S3 paths.

### Base app path

```text
base-app/<projectType>-base-app
```

Example:

```text
base-app/nextjs-base-app
```

### Project path

```text
projects/<projectName>_<projectId>/code-<projectType>
```

Example:

```text
projects/my-app_project_123/code-nextjs
```

If the project path already exists, the container treats it as an existing project and restores it.

If it does not exist, the container copies the base app into that project path first.

---

## File sync

After code-server starts, `startProjectSync.ts` watches the project directory:

```text
/app/projects/<projectName>_<projectId>/code-<projectType>
```

When files change, it syncs the project back to S3.

This is what makes project files survive container/VM restarts.

---

## Important files

| File | Purpose |
|---|---|
| `docker/Dockerfile.codeserver` | Builds the `my-code-server` image |
| `entrypoint.sh` | Main container startup script |
| `scripts/vmBaseSetup.ts` | Decides whether to restore existing project or create from base app |
| `scripts/fetch-base-app-from-s3.ts` | Lists, copies, and downloads S3 files |
| `scripts/upload-base-app-to-s3.ts` | Uploads base app files to S3 |
| `scripts/startProjectSync.ts` | Watches local project files and syncs them back to S3 |

---

## Container startup

`entrypoint.sh` is the main runtime entrypoint.

It does:

```text
bun scripts/vmBaseSetup.ts
cd /app/projects/<projectName>_<projectId>/code-<projectType>
bun install
install CodeTogether extension
start sync watcher
write code-server settings
start code-server on port 8080
```

The final workspace is opened at:

```text
http://<EC2_PUBLIC_IP>:8080
```

---

## Build and push image

From this package:

```bash
docker build -t my-code-server -f docker/Dockerfile.codeserver .
docker tag my-code-server ritikaxg/my-code-server:latest
docker push ritikaxg/my-code-server:latest
```

On the AMI VM, pull and tag it as:

```bash
docker pull ritikaxg/my-code-server:latest
docker tag ritikaxg/my-code-server:latest my-code-server
```

The VM agent expects the local image name:

```text
my-code-server
```

---

## AWS credentials

This package uses S3.

For local Docker testing, credentials must come from your local AWS environment.

For EC2/ASG runtime, credentials should come from the IAM role attached to the EC2 instance through the launch template.

Do not bake AWS access keys into the image.

---

## Current code note

The current S3 helper scripts hardcode the bucket name as:

```text
bolt-app-v1
```

If you move to a new bucket, update the scripts or move the bucket name to an environment variable, then rebuild and push the image.

---

## Summary

`vm-base-config` is responsible for turning a blank code-server container into a real SpinUp workspace.

It handles:

```text
S3 project restore
base-app copy
dependency install
file sync
CodeTogether setup
code-server startup on 8080
```
