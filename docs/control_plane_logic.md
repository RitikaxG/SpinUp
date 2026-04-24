# SpinUp — Control Plane Logic

This document explains how the `apps/web` backend controls VM allocation, project runtime lifecycle, autoscaling, deletion, cleanup, heartbeat, and failure recovery.

The goal is to understand the backend flow in one connected story:

```text
User creates project
  → control plane creates/resumes project
  → safe locks are acquired
  → VM is allocated from ASG
  → VM agent starts container
  → project becomes READY
  → heartbeat keeps checking it
  → cleanup/recovery handles failures
```

---

## 1. Mental model

SpinUp has three layers:

```text
1. Postgres
   Source of truth for project lifecycle.

2. Redis
   Fast coordination layer for runtime assignments, locks, and heartbeat metadata.

3. AWS + VM agent
   External runtime layer where EC2 instances and Docker containers actually run.
```

The control plane connects all three.

It answers questions like:

- Has this project already been created?
- Is this project already booting?
- Which VM is assigned to this project?
- Is there an idle VM available?
- Should the ASG scale up?
- Did the VM agent become healthy?
- Did the container start?
- Should this runtime be marked failed?
- Can this VM be reused or should it be terminated?

---

## 2. Main backend files

Inside `apps/web`, the important backend files are:

```text
app/api/project/route.ts
services/projectControlPlane.ts
services/ec2Manager.ts
services/asgManager.ts
services/projectLifecycleManager.ts
services/redisManager.ts
services/projectRuntimeTruthSource.ts
services/runtimeHeartbeatManager.ts
services/controlPlaneReconciler.ts

lib/aws/asgCommands.ts
lib/aws/ec2Commands.ts
lib/vmAgent/client.ts
lib/autoscaling/config.ts
lib/control-plane/config.ts
lib/config/env.ts
```

Their responsibilities:

| File | Responsibility |
|---|---|
| `route.ts` | API entrypoint for project create/delete/list |
| `projectControlPlane.ts` | Orchestrates project create/resume/delete |
| `ec2Manager.ts` | Allocates VM, starts runtime, handles boot failure |
| `asgManager.ts` | Computes ASG capacity, idle pool, unhealthy cleanup |
| `projectLifecycleManager.ts` | Valid lifecycle transitions and project events |
| `redisManager.ts` | Redis locks, runtime mirror, cleanup helpers |
| `projectRuntimeTruthSource.ts` | DB-first runtime state reader |
| `runtimeHeartbeatManager.ts` | Periodic health checks and recovery |
| `controlPlaneReconciler.ts` | Runs heartbeat + warm pool reconciliation |
| `vmAgent/client.ts` | HTTP client for VM agent on port `3000` |

---

## 3. Source of truth: Postgres first

The most important design decision:

```text
Postgres is the source of truth.
Redis is a mirror/coordination layer.
```

Postgres stores:

```text
Project.status
Project.assignedInstanceId
Project.publicIp
Project.containerName
Project.bootStartedAt
Project.bootCompletedAt
Project.lastHeartbeatAt
Project.lastEventType
Project.lastEventMessage
```

Redis stores a fast runtime mirror:

```text
instance:<instanceId>
user:<userId>:instance
project:<projectId>:instance
instances:active
```

Why this matters:

- If Redis loses state, the backend can rehydrate from Postgres.
- If a runtime is assigned in Postgres, the backend treats it as real.
- Redis is used for speed and locks, not as the final lifecycle truth.

---

## 4. Project lifecycle

The core project lifecycle is:

```text
CREATED
  → ALLOCATING_VM
  → BOOTING_CONTAINER
  → READY
```

Other states:

```text
STOPPED
FAILED
DELETING
DELETED
```

### Lifecycle meaning

| Status | Meaning |
|---|---|
| `CREATED` | Project row exists, but no runtime has started |
| `ALLOCATING_VM` | Backend is finding or creating VM capacity |
| `BOOTING_CONTAINER` | VM is assigned and container boot is in progress |
| `READY` | Workspace container is running and reachable |
| `STOPPED` | Runtime was stopped but project still exists |
| `FAILED` | Runtime provisioning or heartbeat failed |
| `DELETING` | Delete request accepted, cleanup is running |
| `DELETED` | Project and runtime artifacts are cleaned up |

The lifecycle manager prevents invalid transitions.

For example:

```text
CREATED → ALLOCATING_VM
ALLOCATING_VM → BOOTING_CONTAINER
BOOTING_CONTAINER → READY
READY → DELETING
DELETING → DELETED
```

This protects the backend from accidentally jumping from an unsafe state to another unsafe state.

---

## 5. API entrypoint

Project creation enters through:

```text
POST /api/project
```

The route does only the API-level work:

1. verify Clerk user,
2. find matching DB user,
3. validate project input,
4. call `createOrResumeProject`.

The heavy runtime logic is not in the route.

The route delegates to the control plane.

---

## 6. Create/resume control plane flow

`createOrResumeProject` handles project creation safely.

The high-level flow:

```text
POST /api/project
  → validate user
  → acquire create lock
  → find or create project
  → handle existing state
  → mark ALLOCATING_VM
  → acquire runtime lock
  → ensure project runtime
```

---

## 7. Create lock: avoiding duplicate projects

When a user creates a project, the backend acquires:

```text
lock:project:create:<ownerId>:<normalizedProjectName>
```

This prevents two duplicate create requests from creating the same project at the same time.

Why this is needed:

A user may double-click the create button, refresh, retry, or the frontend may send duplicate requests.

Without this lock:

```text
Request A creates project
Request B creates same project
Both try to allocate runtime
```

With the lock:

```text
Only one create flow runs.
The other request gets an in-progress/conflict response.
```

---

## 8. Existing project handling

If a project already exists, the backend does not blindly create another one.

It checks the existing project status.

### If existing project is `READY`

Return the existing runtime.

```text
No new VM is allocated.
No new container is started.
```

### If existing project is `ALLOCATING_VM` or `BOOTING_CONTAINER`

Return `202`.

```text
Runtime provisioning is already in progress.
```

### If existing project is `FAILED` or `STOPPED`

Try to allocate runtime again.

### If same project name exists with different project type

Return `409`.

Example:

```text
Existing: my-app / NEXTJS
Requested: my-app / REACT
```

This avoids corrupting the S3/project runtime path.

---

## 9. Runtime lock: avoiding double VM/container boot

Before starting a runtime, the backend acquires:

```text
lock:project:runtime:<projectId>
```

This lock protects the most dangerous section:

```text
allocate VM
fetch public IP
wait for VM agent
start container
wait for readiness
mark READY
```

Without this lock, two requests could do this at the same time:

```text
Request A assigns VM-1
Request B assigns VM-2
Both try to start spinup-<projectId>
Project state becomes inconsistent
```

With the runtime lock:

```text
Only one runtime boot flow can run per project.
```

The lock TTL is long because runtime boot can take several minutes.

---

## 10. One active runtime per user

SpinUp v1 is designed so one user has one active runtime at a time.

Before starting a new project runtime, the backend checks:

```text
Does this user already have another active project with an assigned VM?
```

Active runtime statuses are:

```text
ALLOCATING_VM
BOOTING_CONTAINER
READY
```

If another active project exists, the backend cleans up that old runtime before assigning the new one.

This prevents one user from consuming multiple VMs at the same time.

Important distinction:

```text
One active runtime per user.
One active project assignment per VM.
Multiple users can still create projects concurrently.
```

---

## 11. Runtime rehydration

Before allocating a fresh VM, the backend checks whether the project already has runtime fields in Postgres:

```text
assignedInstanceId
publicIp
status = BOOTING_CONTAINER or READY
```

If yes, it rehydrates Redis from Postgres.

This handles cases like:

```text
Redis restarted
Backend restarted
Request retried after partial success
Project already has a VM assignment
```

If the project is already `READY`, the backend returns the existing runtime instead of booting a new one.

---

## 12. VM allocation flow

The VM allocation is handled by `allocateVmAndScaleUp`.

High-level flow:

```text
try get idle VM
  ↓
if idle VM exists, return it
  ↓
if no idle VM, trigger ASG scale-up
  ↓
wait until an idle VM appears
  ↓
return VM instance ID
```

Current wait behavior:

```text
VM wait timeout: 180 seconds
poll interval: 5 seconds
```

If no VM becomes available within the timeout:

```text
project → FAILED
reason → "No idle machine available within wait timeout"
```

---

## 13. What counts as an idle VM?

A VM is considered reusable only if it passes all checks:

```text
ASG LifecycleState = InService
ASG HealthStatus = Healthy
No active project assigned in Postgres
Redis status = IDLE or UNTRACKED
Public IP exists
VM agent health endpoint responds
```

The VM agent check is:

```text
GET http://<publicIp>:3000/health
```

This is important because an EC2 instance can be `Healthy` in ASG but still not ready for SpinUp.

For SpinUp, a VM is only useful if:

```text
EC2 is healthy
networking works
systemd agent is running
Docker control is available through the VM agent
```

---

## 14. Why DB is checked before reusing a VM

A VM can look idle in Redis but still be assigned in Postgres if Redis is stale.

So before treating a VM as idle, the backend checks the DB assignment state.

This prevents a bug like:

```text
Redis says VM is idle
Postgres says VM belongs to Project A
Project B gets assigned to same VM
```

The DB check prevents this.

---

## 15. ASG scale-up logic

If no idle VM exists, the backend calls the ASG scaling logic.

The autoscaling config is:

```ts
MIN_IDLE = 2
MAX_IDLE = 5
MAX_TOTAL_INSTANCES = 10
IDLE_TIMEOUT_MINUTES = 10
```

The control plane builds a snapshot:

```text
totalInstances
desiredCapacity
healthyInServiceCount
unhealthyCount
idleCount
busyCount
idleInstanceIds
```

Then it computes a scaling plan.

---

## 16. Scaling rules

### Rule 1: unhealthy instances are handled separately

If there are unhealthy instances:

```text
Do not make normal scale decisions yet.
Cleanup handles unhealthy instances first.
```

This avoids making scaling decisions based on broken capacity.

---

### Rule 2: idle count below minimum means scale up

If:

```text
idleCount < MIN_IDLE
```

then the ASG should scale up.

Example:

```text
MIN_IDLE = 2
idleCount = 0
desiredCapacity = 3

missingIdle = 2
targetDesiredCapacity = 5
```

The target is capped by:

```text
MAX_TOTAL_INSTANCES = 10
```

---

### Rule 3: idle count within band means keep

If:

```text
MIN_IDLE <= idleCount <= MAX_IDLE
```

then no scaling change is needed.

Example:

```text
idleCount = 3
MIN_IDLE = 2
MAX_IDLE = 5

Decision: KEEP
```

---

### Rule 4: idle count above max means recycle

If:

```text
idleCount > MAX_IDLE
```

then extra idle VMs are terminated.

Example:

```text
idleCount = 7
MAX_IDLE = 5
overflow = 2

Terminate 2 idle VMs
```

---

## 17. Scale-up lock: avoiding over-scaling

Multiple users can create projects at the same time.

Without a scale-up lock:

```text
User A sees no idle VM → scale up
User B sees no idle VM → scale up
User C sees no idle VM → scale up
```

That can over-scale the ASG.

SpinUp uses:

```text
lock:asg:scale-up
```

Only one request can execute the scale-up mutation at a time.

Other requests wait for capacity to appear instead of all increasing desired capacity.

---

## 18. Desired capacity safety

When setting ASG desired capacity, the backend clamps the target:

```text
minimum = ASG min size
maximum = min(ASG max size, SpinUp MAX_TOTAL_INSTANCES)
```

So even if the computed target is too high, the backend keeps it inside safe bounds.

This protects against accidental runaway scaling.

---

## 19. Public IP wait

After a VM is selected, the backend waits for its public IP.

This matters because the VM agent is called over:

```text
http://<publicIp>:3000
```

If the public IP does not appear, the backend cannot control the VM.

Failure handling:

```text
cleanup failed instance
project → FAILED
reason → failed to fetch public IP
```

Common causes:

- launch template public IP disabled,
- subnet auto-assign public IP disabled,
- route table/internet gateway issue,
- wrong subnet selected in ASG.

---

## 20. VM agent health wait

After public IP is fetched, the backend waits for:

```text
GET http://<publicIp>:3000/health
```

This confirms:

```text
VM booted
systemd service started
Bun agent is running
Docker control path is reachable
security group allows port 3000
```

If the VM agent never becomes healthy:

```text
cleanup failed instance
project → FAILED
```

---

## 21. Project moves to BOOTING_CONTAINER

Once the VM agent is healthy, the backend marks:

```text
project.status = BOOTING_CONTAINER
```

At this point Postgres gets:

```text
assignedInstanceId
publicIp
bootStartedAt
```

Then Redis mirrors the booting state:

```text
instance:<instanceId> = {
  instanceId,
  userId,
  projectId,
  projectName,
  projectType,
  publicIP,
  containerName: "",
  inUse: "true",
  status: "BOOTING"
}
```

This prevents the VM from being picked by another project while the container is still booting.

---

## 22. Container start through VM agent

The backend builds a deterministic container name:

```text
spinup-<projectId>
```

Then it calls:

```text
POST http://<publicIp>:3000/start
```

The VM agent starts:

```bash
docker run -d \
  --name spinup-<projectId> \
  -e PROJECT_ID=<projectId> \
  -e PROJECT_NAME=<projectName> \
  -e PROJECT_TYPE=<projectType> \
  -p 8080:8080 \
  my-code-server
```

Why deterministic container names matter:

- retries are safer,
- cleanup knows exactly what to stop,
- heartbeat knows which container to inspect,
- duplicate containers for the same project are avoided.

---

## 23. Container start is idempotent

The VM agent handles retries safely.

When `/start` is called:

1. if the container already exists and is running, return success,
2. if it exists but is stopped, start it,
3. if it does not exist, create it.

This means a retry does not always create a new container.

That protects against network retries or API retries during boot.

---

## 24. Runtime readiness check

After `/start`, the control plane does not immediately mark the project ready.

It waits for runtime readiness by checking:

```text
POST http://<publicIp>:3000/containerStatus
GET  http://<publicIp>:8080
```

The project becomes `READY` if either:

```text
container reports running
or
workspace HTTP endpoint responds
```

This avoids marking a project ready before the workspace is usable.

---

## 25. Project moves to READY

When runtime is ready:

```text
project.status = READY
```

Postgres stores:

```text
assignedInstanceId
publicIp
containerName
bootCompletedAt
lastHeartbeatAt
```

Redis updates from:

```text
BOOTING
```

to:

```text
RUNNING
```

Redis now contains:

```text
status = RUNNING
inUse = true
containerName = spinup-<projectId>
```

The API returns the runtime assignment to the frontend.

The frontend can open:

```text
http://<publicIp>:8080
```

---

## 26. What can go wrong during boot?

### 26.1 No idle VM available

Handling:

```text
try scale up
wait for idle VM
if timeout → project FAILED
```

---

### 26.2 ASG cannot scale

Possible causes:

- wrong AWS credentials,
- missing ASG permission,
- ASG name wrong,
- ASG max size reached,
- launch template invalid.

Handling:

```text
scale-up fails or no capacity appears
project eventually FAILED
```

---

### 26.3 VM has no public IP

Possible causes:

- public IP disabled in launch template,
- subnet setting wrong,
- networking issue.

Handling:

```text
cleanup failed instance
project FAILED
```

---

### 26.4 VM agent unreachable

Possible causes:

- port `3000` closed,
- systemd agent failed,
- Bun path wrong,
- Docker not installed,
- VM not fully booted.

Handling:

```text
cleanup failed instance
project FAILED
```

---

### 26.5 Docker container fails to start

Possible causes:

- `my-code-server` image missing,
- image architecture mismatch,
- S3 bucket name wrong,
- IAM role missing S3 access,
- startup script fails,
- port `8080` conflict.

Handling:

```text
cleanup failed instance
project FAILED
```

---

### 26.6 Project deleted while booting

The boot flow repeatedly checks whether deletion was requested.

If project status becomes:

```text
DELETING
or
DELETED
```

during provisioning, the backend cancels boot and cleans up.

This prevents a race like:

```text
User creates project
User immediately deletes project
Backend still marks project READY
```

Instead:

```text
delete wins
runtime boot is cancelled
```

---

## 27. Failure handling strategy

SpinUp follows this pattern:

```text
Detect failure
  → log structured error
  → cleanup unsafe runtime if needed
  → clear or preserve runtime fields depending on debug mode
  → mark project FAILED
  → write lifecycle event
```

For production behavior:

```text
failed runtime is cleaned up
project assignment fields are cleared
```

For debug mode:

```text
failed runtime can be preserved for inspection
```

This helps during development because you can SSH into the failed VM and inspect Docker logs.

---

## 28. Cleanup flow

Cleanup is used when:

- project is deleted,
- user starts another project,
- heartbeat detects failure,
- boot is cancelled,
- unhealthy VM must be removed.

Cleanup flow:

```text
find project runtime assignment
  ↓
call VM agent /stop
  ↓
remove Docker container
  ↓
check VM health
  ↓
if VM healthy → mark VM IDLE
  ↓
if VM unhealthy → terminate VM
  ↓
clear Redis mappings
  ↓
clear Postgres assignment
```

---

## 29. Returning a VM to idle pool

If the container is stopped successfully and the VM agent is still healthy:

```text
VM is returned to IDLE
```

Redis becomes:

```text
status = IDLE
inUse = false
projectId = ""
userId = ""
containerName = ""
```

That VM can now be reused by another project.

This is the key cost optimization.

---

## 30. Terminating instead of reusing

A VM is terminated instead of reused when:

- container stop fails,
- VM agent health check fails,
- instance is unhealthy,
- runtime recovery decides host is unsafe,
- failed boot cleanup needs replacement.

In that case:

```text
terminate instance through ASG
delete Redis lifecycle
let ASG replace capacity if desired capacity requires it
```

This keeps bad hosts from staying in the pool.

---

## 31. Project deletion flow

Delete enters through:

```text
DELETE /api/project?id=<projectId>
```

The flow:

```text
acquire delete lock
  → verify user owns project
  → mark project DELETING
  → acquire runtime lock
  → cleanup runtime assignment
  → delete S3 project artifacts
  → finalize project deletion
  → mark DELETED
```

The delete lock is:

```text
lock:project:delete:<projectId>
```

The runtime lock is also used so delete cannot race with boot.

---

## 32. Why deletion uses locks

Without locks:

```text
Create request is booting container
Delete request clears assignment
Create request finishes and marks READY
```

That would leave a deleted project with a running runtime.

With locks and cancellation checks:

```text
delete and runtime boot coordinate
only one runtime mutation happens at a time
boot notices deletion and cancels
```

---

## 33. Heartbeat system

The control plane periodically checks active runtimes.

Active runtimes are projects with:

```text
status in ALLOCATING_VM, BOOTING_CONTAINER, READY
assignedInstanceId != null
```

Heartbeat checks:

```text
POST http://<publicIp>:3000/containerStatus
GET  http://<publicIp>:3000/health
```

If healthy:

```text
Redis heartbeat updated
failure count reset
Project.lastHeartbeatAt updated
```

If unhealthy:

```text
failure is recorded
after threshold, recovery starts
```

---

## 34. Soft vs hard heartbeat failures

Heartbeat failures are classified.

### Soft failure

Examples:

```text
temporary network issue
container status endpoint timeout
unexpected non-running status
```

Soft failures are counted.

After enough soft failures:

```text
runtime recovery starts
```

Current threshold:

```text
HEARTBEAT_FAILURE_THRESHOLD = 3
```

### Hard failure

Examples:

```text
missing projectId
missing userId
missing publicIP
missing containerName
container stopped
```

Hard failures trigger recovery immediately.

---

## 35. Runtime recovery

When heartbeat decides a runtime is bad:

```text
acquire project runtime lock
  → verify DB assignment still belongs to this project
  → append RUNTIME_RECOVERY_STARTED event
  → cleanup runtime assignment
  → mark project FAILED
  → append RUNTIME_RECOVERY_COMPLETED event
```

The important safety check is:

```text
Does this instance still belong to this project in Postgres?
```

If not, recovery skips.

This prevents stale heartbeat data from cleaning up a runtime that was already reassigned.

---

## 36. Control plane reconciler

The control plane tick runs:

```text
runControlPlaneTick()
```

It does two things:

```text
1. runHeartbeatReconcile()
2. reconcileWarmPool()
```

It uses a tick lock:

```text
lock:control-plane:tick
```

This prevents overlapping worker ticks.

Without this lock, two worker loops could both try to cleanup/scale at the same time.

---

## 37. Warm pool reconciliation

Warm pool reconciliation keeps ASG capacity healthy.

It does:

```text
1. terminate unhealthy instances
2. terminate idle instances that timed out
3. compute scaling snapshot
4. scale up if idle count is below MIN_IDLE
5. recycle idle overflow if idle count is above MAX_IDLE
```

This means capacity is managed both:

```text
on request path
and
in background reconciliation
```

Request path helps users get capacity immediately.

Background reconciliation keeps the pool healthy over time.

---

## 38. Unhealthy instance cleanup

If ASG marks an instance unhealthy:

```text
HealthStatus = Unhealthy
```

the backend:

1. checks if a project is assigned,
2. marks that project/room failed if needed,
3. terminates the unhealthy instance,
4. deletes stale Redis lifecycle.

If the unhealthy instance had an active project, the project is marked:

```text
FAILED
```

The runtime can later be retried through the normal project create/resume flow.

---

## 39. Idle timeout cleanup

Idle VMs are not kept forever.

If an idle VM has been unused longer than:

```text
IDLE_TIMEOUT_MINUTES = 10
```

it can be terminated.

This controls cost.

Important:

```text
Busy/project-assigned VMs are not terminated by idle timeout.
Only idle candidates are considered.
```

---

## 40. Multiple users creating projects

When multiple users create projects at the same time:

```text
Each project has its own runtime lock.
Each user/project name has its own create lock.
ASG scale-up has one global scale-up lock.
```

This gives safe concurrency:

- User A and User B can both create projects.
- They cannot corrupt each other's project state.
- They cannot both assign the same idle VM because VM assignment checks DB and Redis.
- They cannot over-scale aggressively because scale-up is locked.

---

## 41. Why one VM is not assigned twice

A VM is considered busy if Postgres has an active project assigned to it.

Before a VM is reused, SpinUp checks:

```text
getAssignedProjectByInstanceId(instanceId)
```

If a project is assigned, the VM is not idle.

This is safer than relying only on Redis.

---

## 42. Why one project is not booted twice

A project cannot be booted twice because of:

```text
lock:project:runtime:<projectId>
```

and lifecycle checks:

```text
if READY → return existing runtime
if BOOTING_CONTAINER → return in-progress
if ALLOCATING_VM → return in-progress
```

So retrying the API does not create a second runtime.

---

## 43. Why one user does not keep multiple VMs

Before allocating a new VM, SpinUp checks if the same user has another active project with an assigned instance.

If yes:

```text
old project runtime is cleaned up
old VM is returned idle or terminated
new project continues allocation
```

This enforces:

```text
one active runtime per user
```

---

## 44. What happens if Redis is stale?

Redis can become stale if:

- Redis restarts,
- backend crashes mid-flow,
- cleanup partially succeeds,
- runtime assignment was written to DB but not Redis.

SpinUp handles this by reading Postgres first.

If Postgres says a project has a runtime:

```text
rehydrate Redis from DB
```

If Redis says an instance is idle but Postgres says it is assigned:

```text
do not reuse it
```

So stale Redis should not corrupt runtime ownership.

---

## 45. What happens if Postgres has stale assignment?

If Postgres points to a runtime that is no longer healthy, heartbeat/recovery detects it.

Then recovery:

```text
cleans runtime
marks project FAILED
clears assignment
```

The user can retry and get a new runtime.

---

## 46. What happens if VM is healthy but container is dead?

Heartbeat checks container status.

If container is stopped or repeatedly unhealthy:

```text
runtime recovery starts
project FAILED
container/VM cleaned up
```

If the VM itself is healthy after cleanup, it may be returned to idle.

If not, it is terminated.

---

## 47. What happens if the VM agent is healthy but workspace is not ready?

During boot, readiness waits for either:

```text
container running
or
workspace HTTP reachable
```

If readiness never succeeds:

```text
container boot fails
project FAILED
failed runtime cleaned up
```

This prevents the frontend from getting a broken workspace marked as ready.

---

## 48. What happens if cleanup fails?

Cleanup tries to converge safely.

If deletion cleanup cannot finish immediately:

```text
project remains DELETING
statusReason explains why
API returns in-progress
```

A later delete/reconcile can resume cleanup.

This is better than falsely marking the project deleted while runtime state still exists.

---

## 49. Backend safety patterns

The control plane uses several safety patterns.

### 49.1 Idempotency

Create/resume and delete/resume are designed to be retried.

Examples:

```text
READY project returns existing runtime
BOOTING project returns in-progress
DELETING project resumes cleanup
VM agent /start reuses existing container
VM agent /stop succeeds if container already absent
```

### 49.2 Locks

Redis locks prevent concurrent mutation:

```text
create lock
runtime lock
delete lock
scale-up lock
tick lock
```

### 49.3 DB-first reads

Postgres is checked before trusting Redis.

### 49.4 Health checks

Backend verifies:

```text
ASG health
VM public IP
VM agent health
Docker container status
workspace HTTP readiness
```

### 49.5 Explicit lifecycle transitions

Projects only move through allowed states.

### 49.6 Cleanup before reuse

A VM is reused only if the old container was removed and the VM is healthy.

---

## 50. End-to-end happy path

```text
1. User creates project
2. API validates user and input
3. Control plane acquires create lock
4. Project row is created
5. Project moves to ALLOCATING_VM
6. Runtime lock is acquired
7. Existing user runtime is cleaned up if present
8. Backend looks for idle VM
9. If no idle VM exists, ASG desired capacity is increased
10. Backend waits for healthy idle VM
11. Public IP is fetched
12. VM agent health is verified on port 3000
13. Project moves to BOOTING_CONTAINER
14. Redis records BOOTING assignment
15. Backend calls VM agent /start
16. VM agent starts Docker container
17. Backend waits for container/workspace readiness
18. Project moves to READY
19. Redis records RUNNING assignment
20. Frontend opens workspace on port 8080
```

---

# Tradeoffs

## Q1. What is the control plane in SpinUp?

The control plane is the backend inside `apps/web` that manages project lifecycle and runtime allocation. It does not run the workspace itself. It decides which VM should run a project, starts/stops containers through the VM agent, updates Postgres/Redis, and reconciles failures.

---

## Q2. Why use an Auto Scaling Group instead of launching EC2 directly?

Because SpinUp needs reusable capacity. The ASG maintains a pool of EC2 VMs. The backend can reuse healthy idle VMs for faster project startup, and scale up only when idle capacity is too low.

---

## Q3. What is the difference between ASG health and SpinUp runtime health?

ASG health only says the EC2 instance is healthy from AWS's perspective. SpinUp runtime health also requires public IP, VM agent health on port `3000`, container status, and workspace readiness on port `8080`.

---

## Q4. How do you prevent two requests from booting the same project twice?

A Redis runtime lock is used:

```text
lock:project:runtime:<projectId>
```

Also, if a project is already `READY`, `ALLOCATING_VM`, or `BOOTING_CONTAINER`, the backend returns the existing/in-progress state instead of starting again.

---

## Q5. How do you prevent duplicate project creation?

A Redis create lock is used:

```text
lock:project:create:<ownerId>:<normalizedProjectName>
```

The backend also checks existing non-deleted projects by owner and normalized name.

---

## Q6. How do you prevent over-scaling when many users create projects?

Scale-up is guarded by a global Redis lock:

```text
lock:asg:scale-up
```

Only one request can mutate ASG desired capacity at a time. Other requests wait for idle capacity.

---

## Q7. How do you decide when to scale up?

The backend computes `idleCount`.

If:

```text
idleCount < MIN_IDLE
```

it increases desired capacity, capped by `MAX_TOTAL_INSTANCES`.

---

## Q8. What is the current idle capacity policy?

```text
MIN_IDLE = 2
MAX_IDLE = 5
MAX_TOTAL_INSTANCES = 10
IDLE_TIMEOUT_MINUTES = 10
```

This means SpinUp tries to keep at least two idle VMs ready, avoids keeping more than five idle VMs, never exceeds ten total instances, and removes idle VMs after ten minutes.

---

## Q9. How does SpinUp know a VM is safe to reuse?

A VM must be:

```text
Healthy + InService in ASG
not assigned to an active project in Postgres
IDLE or UNTRACKED in Redis
public IP available
VM agent health check passing
```

---

## Q10. Why check Postgres before Redis?

Because Postgres is the source of truth. Redis can be stale. A VM is not reused if Postgres says it is assigned to an active project, even if Redis looks idle.

---

## Q11. What happens if Redis crashes?

The backend can rehydrate Redis from Postgres when a project already has `assignedInstanceId` and `publicIp`. Redis is used for locks and fast lookup, but project lifecycle truth is in Postgres.

---

## Q12. What happens when a project reaches `BOOTING_CONTAINER`?

It means:

```text
VM is assigned
public IP is known
VM agent is healthy
container start is in progress
```

Postgres stores the assignment and Redis marks the VM as `BOOTING`.

---

## Q13. What does the VM agent do?

The VM agent runs on each EC2 VM on port `3000`. It exposes `/health`, `/start`, `/stop`, and `/containerStatus`. It is responsible for controlling Docker containers on that VM.

---

## Q14. Why is code-server on port `8080` and the agent on `3000`?

They are different services.

```text
3000 = control API for the backend
8080 = user-facing code-server workspace
```

The backend talks to `3000`. The user opens `8080`.

---

## Q15. How is the Docker container named?

The backend uses:

```text
spinup-<projectId>
```

This makes start, status, heartbeat, and cleanup deterministic.

---

## Q16. How do retries work during container start?

The VM agent checks whether the container already exists.

If running, it returns success.
If stopped, it starts it.
If missing, it creates it.

So retries are safe.

---

## Q17. When is a project marked `READY`?

Only after the backend verifies that:

```text
container is running
or
workspace HTTP endpoint responds
```

Then Postgres moves to `READY`, Redis moves to `RUNNING`, and the frontend can open the workspace.

---

## Q18. What happens if the container fails to start?

The backend logs the failure, cleans up the failed runtime, and marks the project `FAILED`.

---

## Q19. What happens if the VM agent never becomes healthy?

The backend treats the VM as unusable, cleans it up, and marks the project `FAILED`.

---

## Q20. What happens if the user deletes the project while it is booting?

The boot flow checks for deletion during provisioning. If the project is `DELETING` or `DELETED`, the backend cancels boot and cleans up instead of marking the project `READY`.

---

## Q21. How does deletion work safely?

Deletion uses a delete lock and runtime lock. It marks the project `DELETING`, stops/removes the container, clears runtime state, deletes artifacts, and only then marks the project `DELETED`.

---

## Q22. What happens to the VM after project deletion?

If the VM is healthy after stopping the container, it is returned to the idle pool. If it is unhealthy, it is terminated.

---

## Q23. How does heartbeat work?

The worker periodically checks active assigned runtimes. It verifies container status and VM agent health. Healthy runtimes update heartbeat timestamps. Repeated failures trigger recovery.

---

## Q24. What is the heartbeat failure threshold?

Current threshold:

```text
HEARTBEAT_FAILURE_THRESHOLD = 3
```

Soft failures are tolerated until the threshold is reached. Hard failures trigger recovery immediately.

---

## Q25. What is runtime recovery?

Runtime recovery cleans up a bad assigned runtime, marks the project `FAILED`, and clears assignment state so the user can retry.

---

## Q26. How are unhealthy ASG instances handled?

Warm-pool reconciliation detects ASG instances with `HealthStatus = Unhealthy`, marks assigned projects failed if needed, terminates the unhealthy instance, and removes stale Redis state.

---

## Q27. How are idle VMs cleaned up?

Idle VMs older than the configured timeout are terminated. This prevents the warm pool from wasting money.

---

## Q28. What does the background control-plane worker do?

It runs:

```text
heartbeat reconciliation
warm-pool reconciliation
```

Heartbeat checks active runtimes.
Warm-pool reconciliation handles unhealthy instances, idle timeout, scale-up, and idle overflow.

---

## Q29. What if two users create projects at the same time?

Each project gets its own runtime lock, and scale-up is globally locked. Both users can proceed concurrently, but they cannot corrupt shared VM/ASG state.

---

## Q30. What if the backend crashes in the middle of provisioning?

Postgres still stores the last lifecycle state and runtime assignment fields. On retry, the backend can resume, return in-progress, rehydrate Redis, or mark failed depending on the current state.

---

## Q31. What makes this backend production-style?

The important production patterns are:

```text
source-of-truth separation
distributed locks
idempotent create/delete
explicit lifecycle transitions
runtime health checks
background reconciliation
failure recovery
safe cleanup
bounded autoscaling
structured events/logging
```

---

## Final summary

The SpinUp control plane safely manages VM-backed workspaces by separating responsibilities:

```text
Postgres = lifecycle truth
Redis = locks + fast runtime mirror
ASG = EC2 capacity pool
VM agent = Docker control on each VM
code-server container = user workspace
```

A project moves through:

```text
CREATED → ALLOCATING_VM → BOOTING_CONTAINER → READY
```

Every risky operation is guarded:

```text
duplicate create → create lock
duplicate boot → runtime lock
duplicate delete → delete lock
over-scaling → scale-up lock
worker overlap → tick lock
stale Redis → DB-first reads
bad runtime → heartbeat recovery
bad VM → terminate or recycle
```

That is the core backend control-plane logic of SpinUp.
