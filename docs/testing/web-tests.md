# SpinUp — `bun run test:web` Test Documentation

This document explains the tests that run when you execute:

```bash
bun run test:web
```

The goal of these tests is to validate the backend control-plane logic inside `apps/web`.

---

## 1. What this command runs

At the repo root:

```json
"test:web": "turbo run test --filter=web"
```

Inside `apps/web`:

```json
"test": "vitest run"
```

So the full flow is:

```text
bun run test:web
  → turbo runs test only for the web package
  → apps/web runs vitest
  → Vitest executes tests under apps/web/tests
```

The tests run in a Node environment, not a browser environment.

---

## 2. CI flow

The GitHub Actions workflow also runs the same test command.

CI does:

```text
checkout repo
→ setup Bun
→ bun install
→ generate Prisma client
→ typecheck
→ bun run test:web
```

So these tests are part of the web backend CI gate.

---

## 3. Shared test setup

File:

```text
apps/web/tests/setup.ts
```

This file prepares the test environment.

It sets default env values such as:

```text
REDIS_URL
DATABASE_URL
PROJECT_ARTIFACT_BUCKET
AWS_REGION
AWS_AUTH_MODE
ASG_NAME
```

It also mocks `ioredis` with an in-memory Redis implementation.

The mock Redis supports:

```text
set / get / del
hset / hgetall
sadd / srem / smembers
eval
multi / exec
```

Why this matters:

```text
Tests can validate Redis-based locks and runtime mappings without needing a real Redis server.
```

After each test, it clears mocks, restores timers, and resets the in-memory Redis state.

---

## 4. Test factories

File:

```text
apps/web/tests/factories/project.ts
```

This file creates reusable fake objects.

It provides helpers like:

```text
makeDBUser()
makeProject()
makeRuntimeAssignment()
makeInstanceRecord()
makeCreateProjectBody()
```

Why this matters:

```text
Tests stay focused on behavior instead of repeatedly writing fake project/user/runtime objects.
```

---

# Test suites

---

## 5. Project API route tests

File:

```text
apps/web/tests/integration/api/project.route.test.ts
```

What it tests:

### 5.1 Create project happy path

Checks that:

```text
POST /api/project
```

calls:

```text
createOrResumeProject()
```

with the authenticated DB user and validated project body.

Expected result:

```text
HTTP 201
project returned
runtime returned
```

---

### 5.2 Delete project happy path

Checks that:

```text
DELETE /api/project?id=<projectId>
```

calls:

```text
deleteOrResumeProject()
```

with:

```text
projectId
ownerId
```

Expected result:

```text
HTTP 200
deleted project returned
```

---

### 5.3 Unauthorized request

Checks that if Clerk does not return a user:

```text
currentUser() = null
```

the route returns:

```text
HTTP 401
```

This protects the API from unauthenticated project creation.

---

### 5.4 Cross-user delete protection

Checks that if the control plane says the user does not own the project, the route returns:

```text
HTTP 403
```

This protects one user from deleting another user's project.

---

## 6. Project validator tests

File:

```text
apps/web/tests/unit/validators/project.test.ts
```

What it tests:

### Valid input

Accepts:

```json
{
  "name": "SpinUp Demo",
  "type": "NEXTJS"
}
```

### Whitespace trimming

Input:

```text
"   SpinUp Demo   "
```

becomes:

```text
"SpinUp Demo"
```

### Name rules

Accepts:

```text
SpinUp Demo 123
```

Rejects:

```text
ab
```

because it is shorter than 3 characters.

Rejects names longer than 50 characters.

Rejects invalid characters like:

```text
SpinUp@Demo
```

### Type rules

Accepts valid project types:

```text
NEXTJS
REACT
REACT_NATIVE
```

Rejects invalid project types like:

```text
VITE
```

Why this matters:

```text
Bad project input is blocked before control-plane allocation starts.
```

---

## 7. ASG scaling plan tests

File:

```text
apps/web/tests/unit/services/asgManager.test.ts
```

This suite tests the pure scaling decision function:

```ts
computeScalingPlan()
```

It does not call AWS.

### 7.1 Scale up when idle count is below minimum

Given:

```text
MIN_IDLE = 2
idleCount = 0
desiredCapacity = 1
totalInstances = 1
```

Expected result:

```text
SCALE_UP
targetDesiredCapacity = 3
```

Why:

```text
SpinUp wants 2 idle VMs available.
Current capacity has 0 idle VMs.
So it adds 2 more desired instances.
```

---

### 7.2 Keep capacity when idle count is within band

Given:

```text
idleCount = 3
target band = 2 to 5
```

Expected result:

```text
KEEP
```

Why:

```text
Capacity is healthy enough; no scaling needed.
```

---

### 7.3 Recycle extra idle instances

Given:

```text
idleCount = 6
MAX_IDLE = 5
```

Expected result:

```text
RECYCLE_IDLE
instanceIds = ["i-1"]
```

Why:

```text
There is 1 extra idle VM above the max idle limit.
```

---

### 7.4 Do not scale normally when unhealthy instances exist

Given:

```text
unhealthyCount = 1
```

Expected result:

```text
KEEP
```

Why:

```text
Unhealthy instances are handled by cleanup first.
Scaling decisions should not be based on broken capacity.
```

---

## 8. EC2/runtime manager tests

File:

```text
apps/web/tests/unit/services/ec2Manager.test.ts
```

This is one of the most important test suites.

It tests:

```text
VM allocation
runtime boot
failure handling
one-runtime-per-user cleanup
delete-during-boot safety
```

---

### 8.1 Reuse idle VM immediately

If `getIdleMachines()` returns an idle instance:

```text
i-idle-1
```

then `allocateVmAndScaleUp()` returns it immediately.

It should not call:

```text
ensureIdleCapacityForAllocation()
```

Why:

```text
If idle capacity already exists, SpinUp should not scale up unnecessarily.
```

---

### 8.2 Wait for ASG scale-up capacity

If no idle VM exists initially, the test checks that SpinUp:

```text
calls ensureIdleCapacityForAllocation()
waits
polls again
returns the idle VM when it appears
```

Why:

```text
Project creation can wait for ASG capacity instead of failing immediately.
```

---

### 8.3 Rehydrate existing READY runtime from DB

If Postgres already has:

```text
status = READY
assignedInstanceId
publicIp
containerName
```

then `ensureProjectRuntime()`:

```text
rehydrates Redis
returns existing runtime
does not allocate a new VM
```

Why:

```text
If Redis is missing but DB has the runtime assignment, SpinUp should not create a duplicate runtime.
```

---

### 8.4 Fail when no idle VM appears within timeout

If no idle VM becomes available within the wait timeout:

```text
ensureProjectRuntime()
```

returns:

```text
null
```

and calls:

```text
markProjectFailed()
```

with:

```text
"No idle machine available within wait timeout"
```

Why:

```text
The project should not stay stuck forever in ALLOCATING_VM.
```

---

### 8.5 Fail when public IP resolution fails

If a VM is allocated but no public IP is found:

```text
waitForPublicIP() = ""
```

then SpinUp:

```text
terminates/replaces the failed instance
deletes Redis lifecycle
marks project FAILED
```

Why:

```text
The control plane cannot talk to the VM agent without a public IP.
```

---

### 8.6 Fail when VM agent does not become healthy

If:

```text
waitForVmAgentHealthy()
```

throws an error, SpinUp:

```text
terminates/replaces the instance
marks project FAILED
```

Why:

```text
A VM is not usable unless its agent on port 3000 is reachable.
```

---

### 8.7 One active runtime per user

If the same user already has an active project runtime:

```text
project_old
```

then before starting the new project, SpinUp calls:

```text
cleanupProjectRuntimeAssignment(project_old, user_123, { mode: "REASSIGN" })
```

Why:

```text
SpinUp v1 enforces one active runtime per user.
```

---

### 8.8 Delete wins during boot

If a project becomes:

```text
DELETING
```

while boot is in progress, SpinUp:

```text
returns null
terminates/scales down the VM safely
deletes Redis lifecycle
does not mark BOOTING_CONTAINER
does not mark READY
```

Why:

```text
A project should never become READY after the user has deleted it.
```

---

## 9. Project control-plane tests

File:

```text
apps/web/tests/unit/services/projectControlPlane.test.ts
```

This suite tests `createOrResumeProject()` and `deleteOrResumeProject()`.

---

### 9.1 Create new project and reconcile runtime

Checks that a new valid project:

```text
creates DB project
marks project ALLOCATING_VM
calls ensureProjectRuntime()
returns HTTP 201 when runtime is ready
```

Why:

```text
This validates the main create-project control-plane path.
```

---

### 9.2 Reuse existing project with same normalized name and type

If the user already has:

```text
SpinUp Demo / NEXTJS
```

and asks again for the same normalized name and type, SpinUp:

```text
does not create a new project
reuses existing project
starts/reconciles runtime if needed
```

Why:

```text
Duplicate create requests should be safe.
```

---

### 9.3 Reject same name with different type

If user already has:

```text
SpinUp Demo / REACT
```

and requests:

```text
SpinUp Demo / NEXTJS
```

the response is:

```text
HTTP 409
```

Why:

```text
Same normalized project name with different project type would create conflicting project/runtime paths.
```

---

### 9.4 Return existing runtime when project is already READY

If project is already:

```text
READY
```

then SpinUp:

```text
returns existing runtime
does not mark ALLOCATING_VM
does not call ensureProjectRuntime()
```

Why:

```text
A ready project should not boot a second runtime.
```

---

### 9.5 Return 202 when allocation is already in progress

If project is already:

```text
ALLOCATING_VM
```

the response is:

```text
HTTP 202
inProgress = true
```

Why:

```text
A retry should know provisioning is already happening.
```

---

### 9.6 Return 202 when container boot is already in progress

If project is already:

```text
BOOTING_CONTAINER
```

the response is:

```text
HTTP 202
inProgress = true
```

Why:

```text
A retry should not start a second container.
```

---

### 9.7 Reject delete by non-owner

If the project does not belong to the requesting user:

```text
deleteOrResumeProject()
```

returns:

```text
HTTP 403
```

Why:

```text
Project deletion must be ownership-protected.
```

---

### 9.8 Create lock already held

If the Redis create lock cannot be acquired, SpinUp returns:

```text
HTTP 409
inProgress = true
```

Why:

```text
Another create request for the same user/project is already running.
```

---

## 10. Runtime heartbeat tests

File:

```text
apps/web/tests/unit/services/runtimeHeartbeatManager.test.ts
```

This suite tests runtime health checking and recovery behavior.

---

### 10.1 Hard failure when container is stopped

If the VM agent reports:

```text
container status = stopped
```

then `checkRuntimeHealth()` returns:

```text
healthy = false
severity = HARD
reason = "Container is stopped"
```

Why:

```text
A stopped container means the runtime is definitely broken.
```

---

### 10.2 Soft failure when health endpoint throws

If container status is running but the health endpoint fails:

```text
connect ECONNREFUSED
```

then the result is:

```text
SOFT failure
```

Why:

```text
It may be a temporary network/runtime issue, so SpinUp does not immediately recover unless threshold is reached.
```

---

### 10.3 Successful heartbeat updates state

On a healthy runtime, SpinUp calls:

```text
updateInstanceHeartbeat(instanceId)
resetHeartbeatFailure(instanceId)
touchProjectHeartbeat(projectId)
```

Why:

```text
Both Redis and Postgres should reflect that the runtime is alive.
```

---

### 10.4 Soft failure below threshold is only recorded

If a soft failure count is still below threshold:

```text
failureCount = 1
```

then outcome is:

```text
SOFT_RECORDED
```

and cleanup is not called.

Why:

```text
Temporary failures should not immediately destroy a runtime.
```

---

### 10.5 Hard failure triggers recovery immediately

If severity is:

```text
HARD
```

then SpinUp:

```text
cleanupProjectRuntimeAssignment()
markProjectFailed()
```

Expected outcome:

```text
RECOVERED
```

Why:

```text
Hard failure means the runtime is unsafe and should be cleaned up.
```

---

### 10.6 Soft failure at threshold triggers recovery

If soft failures reach:

```text
3
```

then SpinUp recovers the runtime.

Why:

```text
Repeated soft failures are treated as real runtime failure.
```

---

### 10.7 Recovery lock not acquired

If runtime recovery cannot acquire its Redis lock:

```text
withDistributedLock() = null
```

then outcome is:

```text
LOCKED_OR_SKIPPED
```

and cleanup does not run.

Why:

```text
Another recovery/cleanup operation may already be running.
```

---

## 11. Current note about `redisManager.cleanup.test.ts`

File:

```text
apps/web/tests/unit/services/redisManager.cleanup.test.ts
```

The filename suggests it should test Redis cleanup behavior.

However, in the current repo state, this file contains route-handler tests similar to the project API route test.

So currently it appears to validate:

```text
POST /api/project create responses
409 same-name/type conflict response
202 provisioning-in-progress response
DELETE /api/project success
401 unauthorized
403 cross-user delete
```

Recommendation:

```text
Either rename this file if it is intentionally testing route behavior,
or replace its content with Redis cleanup tests.
```

A proper Redis cleanup test should verify:

```text
cleanupProjectRuntimeAssignment()
  → calls VM agent /stop
  → clears user/project Redis mappings
  → returns healthy VM to IDLE
  → terminates unhealthy VM instead of reusing it
```

---

# What these tests protect

Together, the test suite protects the backend from these bugs:

| Risk | Covered by |
|---|---|
| Invalid project names/types | validator tests |
| Unauthenticated project creation | route tests |
| Cross-user deletion | route/control-plane tests |
| Duplicate project creation | projectControlPlane tests |
| Same name with different type conflict | projectControlPlane/route tests |
| Retried create while provisioning | projectControlPlane/route tests |
| Over-scaling logic bugs | asgManager tests |
| Not reusing idle VMs | ec2Manager tests |
| Runtime stuck without VM | ec2Manager tests |
| Public IP missing | ec2Manager tests |
| VM agent unreachable | ec2Manager tests |
| User getting multiple active runtimes | ec2Manager tests |
| Delete while booting race | ec2Manager tests |
| Dead container not detected | heartbeat tests |
| Temporary heartbeat failure overreacting | heartbeat tests |
| Recovery running twice | heartbeat lock test |

---

# Summary

The `bun run test:web` suite validates the safety of the SpinUp control plane.

It does not test UI rendering. It focuses on backend correctness:

```text
project validation
auth/ownership checks
project lifecycle decisions
ASG scale plan decisions
safe VM allocation
runtime boot failure handling
one-runtime-per-user behavior
delete-during-boot race handling
heartbeat and recovery behavior
Redis-backed coordination
```


```text
These tests focus on the failure paths, not just the happy path.
They prove that the backend handles retries, duplicate requests, unavailable VM capacity,
unhealthy runtimes, and delete/boot races safely.
```
