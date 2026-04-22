# SpinUp Control Plane Validation

This document records the manual end-to-end validation performed on SpinUp’s control plane, runtime allocation flow, lifecycle transitions, cleanup behavior, heartbeat recovery, and authorization rules.

The goal of this test pass was to validate:

- one clean happy path
- the 6 non-negotiable edge cases that matter before demo

---

## What was tested

### Happy path
Validated the smallest successful end-to-end project lifecycle:

1. create project
2. project enters `ALLOCATING_VM`
3. VM gets assigned
4. public IP resolves
5. VM agent becomes reachable
6. container boots
7. project becomes `READY`
8. Redis assignment is written
9. logs show the full lifecycle end to end

### Non-negotiable edge cases
The following critical edge cases were tested:

- repeated create request for the same project
- delete while boot is in progress
- delete after ready
- no idle instance available
- heartbeat failure path
- ownership/auth checks

---

## What we proved

### 1. Happy path works end to end
A project can successfully move through the expected lifecycle:

`CREATED -> ALLOCATING_VM -> BOOTING_CONTAINER -> READY`

This proved:

- control plane create flow works
- VM allocation works
- public IP fetch works
- VM agent readiness check works
- container boot + workspace readiness work
- project lifecycle transitions are valid
- Redis assignment is mirrored correctly
- API returns success when runtime is ready


**Evidence attached:**
[![Container Booting Logs](../../images/happy_path.png)]
[![Container Started inside VM](../../images/vm_started.png)]
[![Project Table Logs](../../images/project_table_logs.png)]
[![Project Event Table Logs](../../images/project_event_table_logs.png)]
[![One project booting lifecycle](../../images/project_room_lifecycle.png)]
[![Redis Logs](../../images/redis_checks.png)]

---

### 2. Repeated create request does not create duplicate runtime
Tested concurrent / repeated create for the same project name.

What was verified:

- only one non-deleted `Project` row existed for that project name
- only one runtime allocation happened
- only one lifecycle chain existed
- no duplicate VM assignment
- no duplicate container boot

This proved that:

- create locking works
- create-or-resume behavior works
- duplicate clicks do not corrupt state

**Result:** pass

**Evidence attached:**
[![Only one project got created](../../images/create_same_project_same_time.png)]
[![One of the request returned 409 Error only got created once](../../images/2_project_same_time.png)]
---

### 3. Delete during boot race was reproduced, fixed, and revalidated
This was one of the most important control plane races.

#### Initial bug found
When delete hit during provisioning, the project could transition to `DELETING`, while provisioning still continued and attempted:

`DELETING -> BOOTING_CONTAINER`

This caused an invalid lifecycle transition and project failure.

#### Fix applied
The runtime provisioning flow was made deletion-aware:

- re-check project lifecycle during provisioning
- stop provisioning if project is already `DELETING` or `DELETED`
- allow repeated delete to resume/reconcile cleanup
- keep lifecycle manager strict

#### Retest result
After the fix:

- delete during `ALLOCATING_VM` / boot no longer caused stale `READY`
- no illegal transition escaped as a `500`
- repeated delete requests resumed cleanup correctly
- final state settled to `DELETED`

This proved:

- delete locking works
- delete resume/reconcile works
- cleanup + finalization are reliable under race conditions
- lifecycle guardrails correctly prevented corruption

**Result:** pass after fix

**Evidence attached:**
![Delete during boot failed initially](../../images/delete_during_boot_failed.png)
![Delete during boot succeeded after fix](../../images/delete_during_boot_fix1.png)
![Delete during boot succeeded after fix](../../images/delete_during_boot_fix2.png)
![Project State](../../images/project_state_query.png)
![Project Lifecycle at delete during booting](../../images/project_lifecycle_query.png)

---

### 4. Delete after ready returns healthy instance to idle pool
Tested delete on a project that was already `READY`.

What was verified:

- project transitioned to `DELETING`
- runtime cleanup started
- container was stopped
- healthy instance was returned to idle pool
- project finalized as `DELETED`

This proved:

- ready-state deletion works
- runtime cleanup works
- warm-pool reuse behavior works
- healthy instances can be recycled instead of always terminated

**Result:** pass

**Evidence attached:**
![Delete after ready logs](../../images/delete_after_ready.png)


---

### 5. No idle instance available path works
Tested project creation when no idle VM was available.

What was verified:

- control plane entered allocation wait path
- scale-up logic triggered
- unhealthy idle candidates were skipped
- a healthy VM eventually became available
- project still reached `READY`

This proved:

- no-idle handling works
- autoscaling wait path works
- allocator does not immediately fail when pool is empty
- health filtering for idle candidates works

**Result:** pass

**Operational insight:**
Keeping `min idle = 1` made create flow significantly more reliable for demo use, because one warm VM is always available.

**Evidence attached:**
![Upscaling at idle_vm = 0](../../images/no_idle_vm_1.png)
![Upscaling at idle_vm = 0](../../images/no_idle_vm_2.png)
![Container Ready after upscaling](../../images/container_ready_after_upscaling.png)

---

### 6. Heartbeat failure path works
Tested failure recovery by intentionally stopping the runtime container for a `READY` project.

What was verified:

- project started in `READY`
- container was stopped manually
- VM agent reported container status as `stopped`
- heartbeat reconcile detected failure
- recovery/cleanup flow ran
- project transitioned `READY -> FAILED`
- runtime assignment was cleared
- healthy VM was returned to idle pool

This proved:

- heartbeat detection works
- hard failure path works
- runtime cleanup works
- project failure marking works
- Redis/runtime state is reconciled correctly after failure

**Result:** pass

**Evidence attached:**
`curl -i -X POST "http://15.207.86.233:3000/stop" \
  -H "Content-Type: application/json" \
  -d '{"containerName":"spinup-cmo8iau3k000gj6y8vpdj99gm"}'`

![Stop Container](../../images/stop_container.png)

`curl -i -X POST "http://15.207.86.233:3000/containerStatus" \
  -H "Content-Type: application/json" \
  -d '{"containerName":"spinup-cmo8iau3k000gj6y8vpdj99gm"}'`

![Verify Container Stopped](../../images/check_container_stopped.png)
![Heartbeat Logs](../../images/heartbeat_logs.png)
![Heartbeat Recovered Verify](../../images/heartbeat_recovered.png)
![Heartbeat Lifecycle](../../images/heartbeat_lifecycle.png)

---

### 7. Unauthenticated requests are blocked
Tested `POST /api/project` without an authenticated Clerk user.

What was verified:

- request returned `401`
- logs recorded auth failure
- no project was created

This proved:

- route-level authentication enforcement works

**Result:** pass

**Evidence attached:**
![Unauthorized - Deny Access](../../images/auth_check.png)


---

### 8. Cross-user delete is forbidden
Tested deleting User A’s project while signed in as User B.

What was verified:

- request returned `403`
- response reason indicated lack of access
- target project remained unchanged in DB
- owner remained correct
- project was not deleted

This proved:

- owner-scoped authorization works
- cross-user delete is blocked correctly

**Result:** pass

**Evidence attached:**
![Delete as User B](../../images/delete_as_user_B.png)
![Logs showing target remains unchanged](../../images/ownership_test.png)

---

## Additional behavior verified

### Single active runtime per user
Tested creating a second project for the same user while another project already had an active runtime.

What was verified:

- old project runtime was cleaned up
- instance was returned to idle
- the same instance was then reassigned to the new project
- only one active runtime remained for the user
- Redis mapped the active instance only to the new project
- `ProjectRoom.vmState` showed:
  - old project: `STOPPED`
  - new project: `RUNNING`

A follow-up improvement was made so the old project transitions cleanly to an inactive lifecycle state instead of remaining semantically stale.

This proved:

- single-runtime-per-user policy works
- runtime handoff is consistent across DB, ProjectRoom, and Redis

**Result:** pass

**Evidence**

![One Project Per User Logs 1](../../images/create_project_same_user1.png)
![One Project Per User Logs 2](../../images/create_project_same_user2.png)

`SELECT id, name, status, "assignedInstanceId", "publicIp", "containerName", "lastEventType", "lastEventMessage"
FROM "Project"
WHERE id IN (
  'cmo9qp7se000as6y8wwrof77m',   -- first project
  'cmo9qpn49000gs6y8ouzt2ioi'    -- second project
)`
![One Project Per User](../../images/verify_one_project_per_user.png)

`SELECT "projectId", "userId", "vmState"
FROM "ProjectRoom"
WHERE "projectId" IN (
  'cmo9qp7se000as6y8wwrof77m',
  'cmo9qpn49000gs6y8ouzt2ioi'
);`
![One Project Per User ProjectRoom Status](../../images/verify_project_status_one_user.png)


---

## Final result

### Happy path
- pass

### Edge cases
- repeated create request: pass
- delete during boot: pass
- delete after ready: pass
- no idle instance available: pass
- heartbeat failure path: pass
- unauthenticated blocked: pass
- cross-user delete blocked: pass

---

## Features validated by this test pass

This validation cycle proved the following parts of SpinUp are working:

- project creation and control plane orchestration
- lifecycle transition correctness
- distributed create/delete/runtime locking
- VM allocation and warm-pool behavior
- runtime reassignment for same user
- VM agent health checks
- container boot / readiness checks
- Redis runtime assignment mirroring
- runtime cleanup and deletion finalization
- heartbeat monitoring and recovery
- unauthenticated access blocking
- owner-scoped authorization

---

## Important fixes discovered during testing

### Delete-during-boot race
A real race was found where delete could move a project to `DELETING` while provisioning still tried to continue boot. This was fixed by making provisioning deletion-aware and by allowing delete requests to resume cleanup reconciliation.

### Old project stale-ready semantics
When a new project for the same user took over the runtime, the old project originally retained a stale `READY` lifecycle status even after its runtime was detached. This was improved so the old project transitions cleanly to an inactive/stopped state.

### Warm-pool stability
Cold-start behavior is more fragile than warm-pool behavior. For reliable demo performance, maintaining at least one warm idle VM (`min idle = 1`) significantly improves success rate.

---

## Recommended demo operating mode

For reliable demos:

- maintain at least one warm idle VM
- keep autoscaling enabled for overflow
- preserve strict lifecycle transitions
- keep heartbeat reconcile enabled
- avoid preserving failed runtimes unless actively debugging

---

## Attached evidence

This README is backed by:

- application logs
- SQL queries against:
  - `Project`
  - `ProjectEvent`
  - `ProjectRoom`
- Redis state checks
- HTTP request / response screenshots
- manual VM agent command results

Screenshots and query outputs are attached alongside this document.