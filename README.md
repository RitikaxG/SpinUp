# SpinUp

SpinUp is a control-plane-first cloud workspace platform inspired by Replit/Bolt-style developer environments.

It lets a user create a project from the browser, then the backend control plane allocates or reuses an EC2 VM, boots a project-specific code-server container, tracks lifecycle state, and exposes the workspace through a browser IDE.

SpinUp is not just a frontend clone. The main focus is the backend/runtime system behind the "Open workspace" button.

---

## Demo

👉 [SpinUp Demo (X)](https://x.com/RitikaxG/status/2049480224946164164?s=20)

---

## What SpinUp does

SpinUp turns a project creation request into a real cloud workspace.

High-level flow:

```text
User creates project
  → SpinUp creates project metadata
  → backend marks project ALLOCATING_VM
  → finds an idle EC2 VM from the ASG warm pool
  → scales ASG if no idle VM is available
  → waits for public IP
  → waits for VM agent health on port 3000
  → asks VM agent to start a project container
  → vm-base-config restores/creates project files
  → code-server starts on port 8080
  → project becomes READY
  → user opens browser IDE
```

The frontend shows each project as a runtime object, not just a database row:

- lifecycle status
- instance ID
- public IP
- container name
- last heartbeat
- boot started/completed timestamps
- last runtime event
- code-server workspace preview

---

## Core highlights

- Real project lifecycle: `CREATED → ALLOCATING_VM → BOOTING_CONTAINER → READY`
- Failure and cleanup states: `FAILED`, `STOPPED`, `DELETING`, `DELETED`
- EC2 Auto Scaling Group based runtime allocation
- Warm-pool style idle VM reuse
- One active runtime per user in v1
- Deterministic project container naming
- Browser IDE through code-server on port `8080`
- VM agent on port `3000` for Docker runtime control
- Postgres as source of truth
- Redis for locks and fast runtime mirror
- Project files restored/synced through S3
- Clerk authentication
- Frontend control-plane dashboard with polling
- Project detail page showing runtime state and workspace preview

---

## Architecture

![SpinUp System Architecture](./docs/images/system_architecture.png)

SpinUp separates responsibilities clearly:

```text
Clerk
  → authentication

Next.js app / apps/web
  → frontend product UI
  → API routes
  → control-plane orchestration

Postgres
  → source of truth for users, projects, rooms, lifecycle state, and events

Redis
  → distributed locks
  → fast runtime assignment mirror
  → instance/project mapping

AWS Auto Scaling Group
  → pool of EC2 instances used as workspace machines

VM agent
  → runs on each EC2 VM
  → exposes Docker control endpoints on port 3000

vm-base-config
  → code-server workspace image
  → restores/creates project files
  → installs dependencies
  → syncs project files to S3
  → starts code-server on port 8080

S3
  → stores base app templates
  → stores project-specific code directories
```

---

## Runtime architecture

```text
POST /api/project
  → validate request
  → verify Clerk user against DB user
  → create or resume project
  → acquire create/runtime lock
  → mark project ALLOCATING_VM
  → clean previous active runtime for same user if needed
  → allocate idle VM or scale ASG
  → wait for EC2 public IP
  → wait for VM agent health
  → mark project BOOTING_CONTAINER
  → call VM agent /start
  → VM agent starts code-server container
  → vm-base-config restores project files from S3
  → code-server starts on 0.0.0.0:8080
  → wait for workspace/container readiness
  → mark project READY
  → mirror runtime assignment to Redis
```

---

## Frontend product views

The frontend is intentionally small. Its purpose is to narrate the backend control plane clearly.

### Clerk sign in

Clerk handles authentication before users can create or open projects.

![Clerk Sign In](./images/frontend/clerk_signin.png)

---

### Landing page

Users create a new workspace by entering a project name and selecting a framework.

Supported project types:

- Next.js
- React
- React Native

![Landing Page](./images/frontend/landing_page.png)

Landing page behavior:

```text
Enter project name
  → select framework
  → create workspace
  → POST /api/project
  → redirect to /projects/[projectId]
```

---

### All projects dashboard

The dashboard lists all active projects for the signed-in user.

Each project card shows:

- project name
- project type
- lifecycle status
- assigned EC2 instance ID
- public IP
- container name
- last event / status reason

Actions:

- Open
- Delete
- Retry / Resume when failed or stopped
- View progress when allocating or booting

![All Projects](./images/frontend/projects.png)

---

### Project detail — booting / progress state

The project detail page is the main demo page.

It polls while the project is in runtime-moving states:

```text
ALLOCATING_VM
BOOTING_CONTAINER
DELETING
```

It shows boot progress as a stepper:

```text
✓ Project created
⏳ Allocating VM
○ Booting container
○ Workspace ready
```

![Project Booting State](./images/frontend/project-1.png)

---

### Project detail — ready state

When the project becomes `READY`, the page shows:

- Open IDE button
- runtime lifecycle state
- instance ID
- public IP
- container name
- heartbeat timestamp
- boot timestamps
- last event
- code-server workspace preview

![Project Ready State](./images/frontend/project_2.png)

The workspace URL model is:

```text
http://<publicIp>:8080/?folder=/app/projects/<projectName>_<projectId>/code-<projectType>
```

Example:

```text
http://13.233.132.155:8080/?folder=/app/projects/my%20project_cmojyv31t0002jiy8c6wbncn3/code-nextjs
```

For the V1 demo, the embedded preview shows the code-server workspace running on the assigned VM.

---

## Project lifecycle

SpinUp tracks project lifecycle in Postgres.

Primary lifecycle:

```text
CREATED
  → ALLOCATING_VM
  → BOOTING_CONTAINER
  → READY
```

Failure / cleanup lifecycle:

```text
STOPPED
FAILED
DELETING
DELETED
```

The frontend maps these states into user-visible behavior:

| Status | UI behavior |
|---|---|
| `CREATED` | Show Start workspace |
| `ALLOCATING_VM` | Show VM allocation progress and poll |
| `BOOTING_CONTAINER` | Show container boot progress and poll |
| `READY` | Show Open IDE + workspace preview |
| `FAILED` | Show reason + Retry |
| `STOPPED` | Show Resume |
| `DELETING` | Disable actions and poll |
| `DELETED` | Hide/remove from active list |

---

## Key features

### Project creation and resume

`POST /api/project` handles both new project creation and project resume.

It can:

- create a new project
- reuse an existing project with the same name/type
- resume a stopped project
- retry a failed project
- return `202` when provisioning is already in progress

---

### VM allocation

SpinUp tries to allocate an idle EC2 instance from the Auto Scaling Group.

If no idle VM is available, it asks the ASG layer to ensure idle capacity, then waits for a VM to become available.

---

### Runtime boot

Once a VM is selected:

```text
wait for public IP
  → wait for VM agent health
  → mark project BOOTING_CONTAINER
  → start project container
  → wait for runtime readiness
  → mark project READY
```

The workspace container is named deterministically:

```text
spinup-<projectId>
```

---

### One active runtime per user

SpinUp v1 allows one active runtime per user.

If a user starts another project while one runtime is already active, the previous runtime is cleaned up before the new one takes over.

---

### Project-aware code-server image

`apps/vm-base-config` turns a generic code-server container into a SpinUp workspace.

It handles:

- S3 project restore
- base app copy
- dependency install
- CodeTogether setup
- file sync back to S3
- code-server startup on port `8080`

Workspace path inside the container:

```text
/app/projects/<projectName>_<projectId>/code-<projectType>
```

S3 project path:

```text
projects/<projectName>_<projectId>/code-<projectType>
```

---

### Persistence through S3

Project files are not tied to a single container.

The runtime image restores project files from S3 and syncs file changes back to S3 so that a project can survive container/VM restarts.

---

### Redis locks and runtime mirror

Redis is used for:

- distributed locks
- project runtime locks
- ASG scaling lock
- fast project ↔ instance mapping
- runtime assignment mirror
- cleanup coordination

Postgres remains the source of truth.

---

### Frontend polling

The project detail page polls only while the project is in active transition states.

```text
ALLOCATING_VM
BOOTING_CONTAINER
DELETING
```

Polling stops automatically when the project reaches a terminal/stable state like:

```text
READY
FAILED
STOPPED
DELETED
```

---

## Tech stack

### Frontend / control plane

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- Zustand
- Clerk
- Prisma
- Postgres
- Redis

### Runtime / infra

- AWS EC2
- Auto Scaling Group
- S3
- Docker
- code-server
- VM agent
- Redis locks
- Postgres lifecycle state

### Tooling

- Bun workspace
- Docker Compose
- Vitest
- Prisma migrations
- ngrok for local Clerk demo flow

---

## Project structure

```text
.
├── apps
│   ├── web
│   │   ├── app
│   │   │   ├── api/project
│   │   │   │   ├── route.ts
│   │   │   │   └── [projectId]/route.ts
│   │   │   ├── projects
│   │   │   │   ├── page.tsx
│   │   │   │   └── [projectId]/page.tsx
│   │   │   ├── components/projects
│   │   │   ├── hooks
│   │   │   ├── lib
│   │   │   ├── store
│   │   │   └── types
│   │   ├── services
│   │   │   ├── projectControlPlane.ts
│   │   │   ├── ec2Manager.ts
│   │   │   ├── asgManager.ts
│   │   │   ├── redisManager.ts
│   │   │   ├── projectLifecycleManager.ts
│   │   │   ├── runtimeHeartbeatManager.ts
│   │   │   └── controlPlaneReconciler.ts
│   │   └── lib
│   │       ├── aws
│   │       ├── vmAgent
│   │       └── control-plane
│   │
│   └── vm-base-config
│       ├── docker
│       ├── scripts
│       ├── entrypoint.sh
│       └── README.md
│
├── packages
│   └── db
│       ├── prisma/schema.prisma
│       └── index.ts
│
├── docs
│   ├── images
│   ├── autoscaling_asg_runtime.md
│   ├── control_plane_logic.md
│   ├── project_docker_startup_guide.md
│   └── testing
│
├── images
│   └── frontend
│       ├── clerk_signin.png
│       ├── landing_page.png
│       ├── all_projects.png
│       ├── project_1.png
│       └── project_2.png
│
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Main code paths

| Path | Purpose |
|---|---|
| `apps/web/app/page.tsx` | Landing page and project creation form |
| `apps/web/app/projects/page.tsx` | All projects dashboard |
| `apps/web/app/projects/[projectId]/page.tsx` | Project detail, lifecycle progress, runtime details, workspace preview |
| `apps/web/app/api/project/route.ts` | List, create/resume, delete projects |
| `apps/web/app/api/project/[projectId]/route.ts` | Fetch one project for detail page polling |
| `apps/web/services/projectControlPlane.ts` | Main create/resume/delete orchestration |
| `apps/web/services/ec2Manager.ts` | VM allocation, public IP wait, VM agent wait, container boot |
| `apps/web/services/asgManager.ts` | Auto Scaling Group capacity decisions |
| `apps/web/services/redisManager.ts` | Runtime locks, Redis mirror, cleanup helpers |
| `apps/web/services/projectLifecycleManager.ts` | Project status transitions and lifecycle events |
| `apps/web/lib/vmAgent/client.ts` | HTTP client for the VM agent |
| `apps/vm-base-config` | Workspace image/bootstrap layer |
| `packages/db/prisma/schema.prisma` | User, project, project room, and project event schema |

---

## Database model

Core tables:

```text
User
Project
ProjectRoom
ProjectEvent
```

Important project fields:

```text
status
statusReason
assignedInstanceId
containerName
publicIp
bootStartedAt
bootCompletedAt
lastHeartbeatAt
lastEventType
lastEventMessage
lastEventAt
deletedAt
```

`ProjectEvent` stores lifecycle history such as:

```text
PROJECT_CREATED
ALLOCATION_STARTED
INSTANCE_ASSIGNED
CONTAINER_BOOT_STARTED
CONTAINER_BOOT_SUCCEEDED
CONTAINER_BOOT_FAILED
PROJECT_STOPPED
HEARTBEAT_OK
HEARTBEAT_FAILED
DELETE_STARTED
DELETE_COMPLETED
```

---

## Local development

### Prerequisites

- Docker Desktop
- Node/Bun environment
- AWS credentials with access to EC2/ASG/S3
- Clerk project
- ngrok for local Clerk demo flow
- Postgres and Redis through Docker Compose

---

### Environment variables

Create a root `.env` file:

```bash
cp .env.example .env
```

Important variables:

```env
NODE_ENV=development
NEXT_TELEMETRY_DISABLED=1

DATABASE_URL=postgresql://postgres:postgres@postgres:5432/spinup_local
REDIS_URL=redis://redis:6379

PROJECT_ARTIFACT_BUCKET=bolt-app-v1
AWS_REGION=ap-south-1
ASG_NAME=codeserver-autoscaling-group

AWS_AUTH_MODE=explicit
EC2_LAUNCHER_ACCESS_KEY=your_local_aws_access_key
EC2_LAUNCHER_ACCESS_SECRET=your_local_aws_secret_key

VM_AGENT_PORT=3000
WORKSPACE_PORT=8080

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
CLERK_SECRET_KEY=your_clerk_secret_key
```

For local Next.js running outside Docker, use localhost URLs instead:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/spinup_local
REDIS_URL=redis://localhost:6379
```

---

### Start local stack with Docker Compose

From repo root:

```bash
docker compose up --build
```

Or detached:

```bash
docker compose up -d --build
```

To run only the required local services:

```bash
docker compose up -d postgres redis migrate web
```

---

### Start ngrok for Clerk demo flow

```bash
ngrok http --url=https://needlessly-classic-gator.ngrok-free.app 3000
```

Open the ngrok URL, not raw localhost, if your Clerk app is configured around the ngrok origin.

---

### Useful commands

```bash
bun install
bun run dev
bun run check-types
bun run test:web
bun run control-plane:worker
```

Docker:

```bash
docker compose ps
docker compose logs -f web
docker compose logs -f migrate
docker compose down
docker compose down -v
```

Postgres:

```bash
docker exec -it spinup-postgres sh
psql -U postgres -d spinup_local
```

Redis:

```bash
docker exec -it spinup-redis sh
redis-cli
```

---

## Current local demo notes

The local control plane can run through Docker Compose, while the actual workspace runtime still launches on EC2 through the AMI → Launch Template → ASG path.

For the current local demo flow:

```text
Docker Compose
  → Postgres
  → Redis
  → migrate
  → web

AWS
  → EC2 Auto Scaling Group
  → VM agent
  → code-server workspace container
```

Recommended demo order:

```text
1. Start Docker Desktop
2. Start local stack
3. Start ngrok
4. Open ngrok URL
5. Sign in with Clerk
6. Confirm the user exists in local Postgres
7. Create project
8. Watch lifecycle progress
9. Open code-server workspace
```

---

## Known limitations

- V1 allows one active runtime per user.
- Local demo currently depends on a configured AWS ASG + AMI + VM agent path.
- Browser preview currently embeds the code-server workspace, not the app dev server on port `3000`.
- The control-plane worker may be kept disabled in local debug/demo mode if it performs aggressive cleanup during testing.
- Current workspace URLs are HTTP-based for the local/demo flow.
- `vm-base-config` currently uses a fixed bucket path in the helper scripts; move this fully to env config before production hardening.

---

## What I learned

This project helped me understand how real cloud workspace products work behind the UI.

Key learnings:

- How a frontend action maps to backend control-plane orchestration
- How to model runtime lifecycle state in Postgres
- How to use Redis for distributed locks and runtime mirrors
- How to allocate and reuse EC2 instances from an ASG
- How to separate control plane from runtime plane
- How to coordinate VM agent health, container boot, and workspace readiness
- How to design retry/resume/delete flows for long-running infrastructure actions
- How to make infra state visible in a product UI
- How to persist project files outside the runtime container through S3
- Why cleanup, cancellation, and reconciliation matter in distributed systems

---

## Status

SpinUp V1 is demo-ready.

Completed:

- Clerk-authenticated frontend
- Landing page
- Project dashboard
- Project detail page
- Runtime lifecycle polling
- Open IDE flow
- Embedded code-server workspace preview
- Project create/resume/delete API
- Postgres lifecycle state
- Redis locks/runtime mirror
- EC2 ASG allocation path
- VM agent integration
- code-server container boot
- S3-backed project restore/sync layer
- Local Docker Compose setup

Next possible improvements:

- HTTPS reverse proxy in front of workspaces
- Per-user workspace routing instead of raw public IPs
- Stronger worker heartbeat/recovery polish
- Better app-preview support for port `3000`
- Workspace terminal/app server automation
- Project logs/event timeline UI
- Team collaboration and permissions
- Production-grade secrets and observability
