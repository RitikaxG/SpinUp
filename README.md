# SpinUp

SpinUp is a control-plane-first developer runtime platform. It creates project workspaces by allocating reusable EC2 VMs from an Auto Scaling Group, starting a project-specific code-server container on the VM, and exposing the workspace in the browser.

## What SpinUp does

- creates or resumes a project from the backend control plane
- finds an idle VM from the ASG warm pool
- scales up the ASG when idle capacity is low
- starts a deterministic Docker container for the project
- exposes code-server on port `8080`
- tracks runtime state in Postgres and Redis
- cleans up or recovers failed runtimes through a worker

## System Architecture

![SpinUp System Architecture](./docs/images/system_architecture.png)

## Main components

| Path | Purpose |
|---|---|
| `apps/web` | Main control plane: APIs, lifecycle, VM allocation, ASG logic, Redis locks, cleanup, heartbeat |
| `apps/vm-base-config` | code-server workspace image: S3 project bootstrap, file sync, CodeTogether, code-server startup |
| `packages/db` | Prisma schema and generated DB client |
| `docs` | Architecture, autoscaling, control-plane, testing, and local setup notes |

External VM agent repo:

```text
https://github.com/RitikaxG/vm-coderserver-start-script
```

That agent runs on every EC2 VM and exposes Docker control endpoints on port `3000`.

## Runtime flow

```text
POST /api/project
  → create/resume project
  → mark ALLOCATING_VM
  → find idle VM or scale ASG
  → wait for public IP
  → wait for VM agent on port 3000
  → mark BOOTING_CONTAINER
  → start spinup-<projectId> container
  → wait for container/workspace readiness
  → mark READY
  → open workspace on port 8080
```

## Core constraints

### One active runtime per user

SpinUp v1 allows one active runtime per user. If a user starts another project, the previous project runtime is cleaned up first.

### Project name uniqueness

Project names are unique per user. If the same normalized name already exists with a different project type, the API returns `409`.

### Long-running create requests

Project creation may wait for ASG capacity. The current backend can wait for roughly 180 seconds before marking the project failed, so the control plane should run as a persistent service.

## Important commands

From repo root:

```bash
bun install
bun run dev
bun run check-types
bun run test:web
bun run control-plane:worker
```

## Key docs

```text
docs/autoscaling_asg_runtime.md
docs/control_plane_logic.md
docs/testing/web-tests.md
docs/project_docker_startup_guide.md
```

## Summary

SpinUp separates runtime responsibility clearly:

```text
Postgres = project lifecycle truth
Redis = locks and fast runtime mirror
ASG = VM capacity
VM agent = Docker control on each VM
vm-base-config = project-aware code-server workspace
```
