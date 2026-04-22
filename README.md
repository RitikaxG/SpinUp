# SpinUp

SpinUp is a control-plane-first developer runtime platform for launching project workspaces on reusable EC2 VMs.

## What v1 does

- create a project from the control plane
- allocate an idle VM from an autoscaled warm pool
- boot a deterministic container for the project
- expose a ready workspace runtime
- stop/delete project runtimes safely
- recover failed runtimes through a control-plane worker
- rehydrate runtime state from DB when Redis mappings are missing

## Core v1 constraints

### 1. One active runtime per user
SpinUp v1 allows only one active project runtime per user.

If a user starts another project while one is already active, the previous project runtime is cleaned up and the new project takes over the available VM capacity.

### 2. Project name uniqueness
Project names are unique per user regardless of project type.

That means a user cannot create:

- `My App` as `NEXTJS`
- `My App` as `REACT`

at the same time.

If a project with the same normalized name already exists under a different type, the API returns `409`.

### 3. Create requests can be long-running
Project creation may wait for an idle VM to appear. In the current v1 implementation, the control plane can wait for up to ~180 seconds before failing the request.

This means the control plane should run on a persistent Node/container deployment rather than a short-timeout serverless environment.

## High-level runtime flow

1. `POST /api/project`
2. create or resume project row
3. if another project for the same user is active, stop it
4. allocate idle VM or wait for warm-pool capacity
5. wait for public IP
6. wait for VM agent health
7. mark project as `BOOTING_CONTAINER`
8. start the deterministic project container
9. wait until runtime becomes ready
10. mark project as `READY`
11. mirror runtime assignment into Redis

## Delete/recovery flow

Delete:

1. mark project as `DELETING`
2. clean up runtime assignment
3. clean up project artifacts
4. finalize to `DELETED`

Recovery:

1. control-plane worker scans active assignments
2. failed health checks increment heartbeat failures
3. hard failures or threshold breaches trigger runtime cleanup
4. project is marked `FAILED`
5. user can retry project start

## Control-plane worker

The worker is required for:

- heartbeat reconciliation
- failed runtime recovery
- warm-pool reconciliation

Run it with:

```bash
bun run control-plane:worker