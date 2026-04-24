# SpinUp Web

`apps/web` is the SpinUp control plane.

It owns the backend logic that creates projects, allocates VMs, starts workspaces, handles cleanup, and reconciles failed runtimes.

## What this app handles

- project create/delete APIs
- project lifecycle transitions
- VM allocation from the ASG
- autoscaling decisions
- Redis distributed locks
- one active runtime per user
- VM agent calls
- container boot readiness
- heartbeat checks
- runtime recovery
- project cleanup

## Important files

| File | Purpose |
|---|---|
| `app/api/project/route.ts` | API entrypoint for create/delete/list |
| `services/projectControlPlane.ts` | create/resume/delete orchestration |
| `services/ec2Manager.ts` | VM allocation and runtime boot |
| `services/asgManager.ts` | ASG idle-pool and scaling logic |
| `services/redisManager.ts` | locks, runtime mirror, cleanup helpers |
| `services/projectLifecycleManager.ts` | valid lifecycle transitions and events |
| `services/runtimeHeartbeatManager.ts` | runtime health checks and recovery |
| `services/controlPlaneReconciler.ts` | worker tick: heartbeat + warm-pool reconcile |
| `lib/vmAgent/client.ts` | HTTP client for the VM agent |

## Project lifecycle

```text
CREATED
  → ALLOCATING_VM
  → BOOTING_CONTAINER
  → READY
```

Failure/cleanup states:

```text
STOPPED
FAILED
DELETING
DELETED
```

## Runtime flow

```text
POST /api/project
  → create/resume project
  → acquire create/runtime locks
  → clean previous runtime for same user if needed
  → allocate idle VM or scale ASG
  → wait for VM public IP
  → wait for VM agent health on port 3000
  → mark BOOTING_CONTAINER
  → call VM agent /start
  → wait for container/workspace readiness
  → mark READY
```

## Safety rules

- Postgres is the source of truth.
- Redis is used for locks and fast runtime lookup.
- A project runtime is guarded by `lock:project:runtime:<projectId>`.
- ASG scale-up is guarded by `lock:asg:scale-up`.
- A VM is reused only if it is healthy, idle, has a public IP, and the VM agent responds.
- If a project is deleted while booting, provisioning is cancelled and the VM is cleaned up.

## Worker

The control-plane worker runs:

```text
heartbeat reconciliation
warm-pool reconciliation
```

Run it with:

```bash
bun run control-plane:worker
```

Heartbeat detects bad runtimes. Warm-pool reconciliation handles unhealthy instances, idle timeout, and scaling.

## Local commands

```bash
bun run dev
bun run check-types
bun run test
bun run test:coverage
```

From repo root, web tests are run with:

```bash
bun run test:web
```

## Summary

`apps/web` is the backend brain of SpinUp. It does not run the workspace itself; it coordinates Postgres, Redis, AWS ASG, EC2, and the VM agent so project runtimes can be allocated, started, monitored, and cleaned up safely.
