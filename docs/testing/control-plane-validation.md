# SpinUp Control Plane Validation

This document records the manual end-to-end validation of SpinUp’s control plane, runtime allocation flow, lifecycle transitions, cleanup behavior, heartbeat recovery, and authorization boundaries.

The goal of this validation pass was simple:

- prove one clean happy path
- prove the 6 non-negotiable edge cases before demo

---

## Scope of validation

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
9. logs show the lifecycle end to end

### Non-negotiable edge cases
The following critical edge cases were tested:

- repeated create request for the same project
- delete while boot is in progress
- delete after ready
- no idle instance available
- heartbeat failure path
- ownership/auth checks

---

# 1. Happy path validation

A project was successfully created and moved through the expected lifecycle:

`CREATED -> ALLOCATING_VM -> BOOTING_CONTAINER -> READY`

## What this proved

- control plane create flow works
- VM allocation works
- public IP fetch works
- VM agent readiness check works
- container boot and workspace readiness work
- lifecycle transitions are valid
- Redis assignment is mirrored correctly
- API returns success when runtime is ready

## Evidence

### Application logs
These screenshots show the successful create request and the runtime moving through allocation, boot, and ready states:

![Happy path logs](../../images/happy_path.png)
![Container started in VM](../../images/vm_started.png)

### Database checks
These queries were used to verify the DB state after a successful create:

- `Project` row created correctly
- lifecycle recorded in `ProjectEvent`
- current runtime reflected in `ProjectRoom`

![Project table logs](../../images/project_table_logs.png)
![Project event table logs](../../images/project_event_table_logs.png)
![Project room lifecycle](../../images/project_room_lifecycle.png)

### Redis checks
These checks verified that the runtime assignment was mirrored correctly in Redis:

![Redis checks](../../images/redis_checks.png)

---

# 2. Repeated create request does not create duplicate runtime

Concurrent / repeated create was tested for the same project name.

## What was verified

- only one non-deleted `Project` row existed for that project
- only one runtime allocation happened
- only one lifecycle chain existed
- no duplicate VM assignment occurred
- no duplicate container boot occurred

## What this proved

- create locking works
- create-or-resume behavior works
- duplicate clicks do not corrupt state

## Result

**Pass**

## Evidence

These screenshots show that the repeated request did not create duplicate runtime state:

![Repeated create check 1](../../images/create_same_project_same_time.png)
![Repeated create check 2](../../images/2_project_same_time.png)

---

# 3. Delete during boot race was reproduced, fixed, and revalidated

This was one of the most important control plane races.

## Initial bug found

When delete hit during provisioning, the project could transition to `DELETING` while provisioning still continued and attempted:

`DELETING -> BOOTING_CONTAINER`

This caused an invalid lifecycle transition and project failure.

## Fix applied

The runtime provisioning flow was made deletion-aware:

- re-check project lifecycle during provisioning
- stop provisioning if project is already `DELETING` or `DELETED`
- allow repeated delete requests to resume / reconcile cleanup
- keep the lifecycle manager strict

## Retest result

After the fix:

- delete during `ALLOCATING_VM` or boot no longer caused stale `READY`
- no illegal lifecycle transition escaped as a `500`
- repeated delete requests resumed cleanup correctly
- final state settled to `DELETED`

## What this proved

- delete locking works
- delete resume / reconcile works
- cleanup and finalization are reliable under race conditions
- lifecycle guardrails prevented corrupted state

## Result

**Pass after fix**

## Evidence

### Before the fix
This screenshot shows the original broken race:

![Delete during boot failed initially](../../images/delete_during_boot_failed.png)

### After the fix
These screenshots show the corrected behavior and successful deletion finalization:

![Delete during boot fixed - logs 1](../../images/delete_during_boot_fix1.png)
![Delete during boot fixed - logs 2](../../images/delete_during_boot_fix2.png)

### Database verification
These checks confirmed that the project no longer remained stale and settled correctly after deletion:

![Project state after delete-during-boot](../../images/project_state_query.png)
![Lifecycle after delete-during-boot](../../images/project_lifecycle_query.png)

---

# 4. Delete after ready returns healthy instance to idle pool

Delete was tested on a project that had already reached `READY`.

## What was verified

- project transitioned to `DELETING`
- runtime cleanup started
- container was stopped
- healthy instance was returned to idle pool
- project finalized as `DELETED`

## What this proved

- ready-state deletion works
- runtime cleanup works
- warm-pool reuse behavior works
- healthy instances can be recycled instead of always terminated

## Result

**Pass**

## Evidence

![Delete after ready](../../images/delete_after_ready.png)

---

# 5. No idle instance available path works

Project creation was tested when no healthy idle VM was available.

## What was verified

- control plane entered allocation wait path
- scale-up logic triggered
- unhealthy idle candidates were skipped
- a healthy VM eventually became available
- project still reached `READY`

## What this proved

- no-idle handling works
- autoscaling wait path works
- allocator does not immediately fail when the pool is empty
- health filtering for idle candidates works

## Result

**Pass**

## Operational insight

Keeping `min idle = 1` made the create flow significantly more reliable for demo use because one warm VM is always available.

## Evidence

These screenshots show the scale-up path and final successful readiness:

![No idle VM - scale up 1](../../images/no_idle_vm_1.png)
![No idle VM - scale up 2](../../images/no_idle_vm_2.png)
![Container ready after upscaling](../../images/container_ready_after_upscaling.png)

---

# 6. Heartbeat failure path works

A failure recovery path was tested by intentionally stopping the runtime container for a project that was already `READY`.

## What was verified

- project started in `READY`
- container was stopped manually
- VM agent reported container status as `stopped`
- heartbeat reconcile detected the failure
- recovery / cleanup flow ran
- project transitioned `READY -> FAILED`
- runtime assignment was cleared
- healthy VM was returned to idle pool

## What this proved

- heartbeat detection works
- hard failure path works
- runtime cleanup works
- project failure marking works
- Redis and DB state are reconciled correctly after failure

## Result

**Pass**

## Evidence

### Manual failure injection
The runtime container was intentionally stopped using the VM agent:

```bash
curl -i -X POST "http://15.207.86.233:3000/stop" \
  -H "Content-Type: application/json" \
  -d '{"containerName":"spinup-cmo8iau3k000gj6y8vpdj99gm"}'