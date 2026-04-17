# SpinUp VM workflow: AMI -> Launch Template -> ASG -> Workspace Container

## Big picture
SpinUp has two different execution environments:

1. **Local control plane on laptop**
   - create AMIs, launch templates, and Auto Scaling groups,
   - build and push Docker images,
   - run the same workspace image locally for debugging.

2. **Cloud runtime on EC2**
   - boot a VM from your AMI,
   - start the VM agent,
   - start the `my-code-server` container,
   - let that container bootstrap and sync project files through S3.

The key distinction is simple:
- **local testing needs your own local AWS credentials**, because your laptop is outside AWS,
- **EC2 runtime does not need hardcoded credentials**, because the instance role can supply temporary credentials through the instance profile / metadata path. 

## End-to-end production flow

### Step 1: Build the VM foundation (AMI)
AMI is not the code-server workspace itself. It is the base VM image that already has the machine-level tooling needed to host workspaces reliably:
- Docker installed and enabled,
- Node and Bun installed,
- the `vm-coderserver-start-script` repo cloned,
- the agent wired into `systemd` so it starts on boot. 

This makes every ASG-launched instance immediately capable of accepting “start workspace” requests without SSH-based manual setup.

### Step 2: Create the runtime IAM role
Create an EC2 role that includes the permissions the **running VM/container** needs. For our current implementation, that primarily means S3 access for the workspace bucket, because `vm-base-config` performs `ListObjectsV2`, `GetObject`, `CopyObject`, `PutObject`, `HeadBucket`, and potentially `CreateBucket`. The role is passed to EC2 through an **instance profile**. AWS’s guidance for Auto Scaling groups is to choose the instance profile in the launch template. 

### Step 3: Create the launch template
The launch template captures the per-instance launch contract:
- AMI ID,
- instance type,
- subnet / public IP behavior,
- security group,
- and IAM instance profile.

It is the bridge between baked VM image and the Auto Scaling group. AWS also notes that if a principal launches instances from a template that contains an instance profile, that principal needs `iam:PassRole`. 

### Step 4: Create the ASG
The ASG uses the launch template to create VMs on demand. Each launched VM already contains Docker + Bun + the VM start agent from the AMI, so SpinUp can treat those instances as ready workspace hosts instead of blank servers.

### Step 5: Start a workspace on a VM
Once a VM is alive, SpinUp calls the VM agent. The agent either:
- reuses an existing container,
- starts a stopped one,
- or runs a fresh `my-code-server` container. It passes `PROJECT_ID`, `PROJECT_NAME`, and `PROJECT_TYPE` into the container and maps `8080:8080`. 

### Step 6: Bootstrap project files inside the container
When `my-code-server` starts, `entrypoint.sh` runs `vmBaseSetup.ts`, which:
- checks whether `projects/${projectName}_${projectId}/code-${projectType}` already exists in S3,
- if it exists, fetches it,
- if it does not, makes sure the base app exists, copies the project-type base app into a project-specific prefix, and fetches it locally. Then it installs dependencies, installs CodeTogether, starts the sync watcher, sets the dark theme, and launches code-server on port 8080. 

## Why credentials are required locally

### Local case A: provisioning AWS resources
If laptop-side code creates or updates EC2 instances, launch templates, or ASGs, it must authenticate to AWS as **you**. That is why your local user needs EC2 / Auto Scaling permissions, and sometimes `iam:PassRole`. AWS explicitly documents `iam:PassRole` when launch templates include an instance profile. 

### Local case B: running `my-code-server` on your laptop
If you run the workspace image locally, that container executes `vmBaseSetup.ts` and calls S3 immediately. Because the container is not on EC2, there is no instance profile path to fall back to. The AWS SDK therefore needs credentials from y local environment or an explicitly configured credential provider. That is why uncommenting explicit credentials or passing working AWS credentials locally made our test succeed. 

## Why credentials are not required inside the EC2 VM path
When the same image runs on a VM launched from my template, the VM has an attached role via the instance profile. AWS states that instance profiles are how roles are passed to EC2, and applications on the instance can access temporary credentials through instance metadata. So the production container can remove hardcoded keys and rely on the instance role instead. 

## Policies and roles: who needs what?

### 1. Local IAM user / local principal
Use this for:
- building infrastructure from your laptop,
- creating/updating launch templates and ASGs,
- local Docker testing when the container needs S3.

Typical permissions:
- EC2,
- Auto Scaling,
- S3,
- `iam:PassRole` when launch templates reference the runtime role. citeturn527489search2turn527489search5

### 2. EC2 runtime role
Use this for:
- the VM agent only if you later make it call AWS,
- and more importantly the `my-code-server` container’s S3 operations.

Typical permissions:
- S3 access to the workspace bucket/prefixes used by `vm-base-config`. 

### 3. Important rule
An IAM **user** is not attached to an EC2 instance. The VM receives a **role** through an **instance profile**. The user is only for your laptop-side or CI-side operations. 

## Recommended mental model
- **AMI** = machine image with Docker + Bun + VM agent installed.
- **Launch Template** = recipe that says how to launch that machine, with security group and IAM role.
- **ASG** = elastic pool that creates those machines.
- **VM agent** = local HTTP control plane on each machine.
- **my-code-server container** = actual developer workspace runtime.
- **S3 bucket** = persistent project/base-app storage shared across VM lifecycles.

## Summary
Our production path works without hardcoded AWS keys because the runtime identity belongs to the EC2 instance role attached through the launch template. While local path needs explicit credentials because my laptop and local Docker containers are outside that EC2 identity boundary.
