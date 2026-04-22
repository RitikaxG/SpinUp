# SpinUp Web App

This package contains the SpinUp control plane, API routes, runtime orchestration logic, and the background worker used for reconciliation.

## What lives here

- `app/api/project/route.ts` — create and delete project endpoints
- `services/projectControlPlane.ts` — create/delete orchestration
- `services/ec2Manager.ts` — VM allocation and runtime boot flow
- `services/redisManager.ts` — Redis lifecycle mirrors, distributed locks, and cleanup helpers
- `services/runtimeHeartbeatManager.ts` — runtime health checks and recovery flow
- `services/asgManager.ts` — warm-pool and autoscaling decisions
- `services/controlPlaneReconciler.ts` — worker tick entry point
- `scripts/control-plane-worker.ts` — long-running reconciliation worker

## Current v1 behavior

### One active runtime per user
SpinUp v1 supports one active runtime per user.

If a user starts another project while one runtime is already active, the currently active runtime is cleaned up and the new project takes over the available capacity.

### Project naming rule
Project names are unique per user regardless of type.

That means the same user cannot create both:

- `My App` as `NEXTJS`
- `My App` as `REACT`

at the same time.

If the normalized project name already exists under a different type, the API returns `409`.

### Long-running create requests
Project creation may wait for an idle VM from the warm pool. In the current v1 flow, the control plane can wait for up to roughly 180 seconds before failing the request.

This package should therefore run on a persistent Node/container deployment rather than a short-timeout serverless path.

## Local commands

Start the app:

```bash
bun run dev
```

Typecheck:

```bash
bun run check-types
```

Run tests:

```bash
bun run test
```

Run coverage:

```bash
bun run test:coverage
```

Run the control-plane worker:

```bash
bun run control-plane:worker
```

## Test strategy

The test suite here is intentionally designed to pass in CI without real AWS infrastructure.

CI covers:

- schema validation
- route response contracts
- control-plane branching
- cleanup logic
- heartbeat recovery logic
- autoscaling decision logic

Manual validation still matters for:

- real AWS VM allocation
- VM agent reachability
- real container boot behavior
- Redis flush/rehydration smoke checks
- worker deployment
- full end-to-end lifecycle validation
