# SpinUp — Local Start README

This README covers the current local development and demo workflow for SpinUp.

It assumes:
- the control plane runs locally through Docker Compose
- the actual workspace runtime still launches on EC2 through the AMI -> Launch Template -> ASG path
- Clerk is used for auth
- a fixed ngrok URL is used locally so Clerk callbacks/origins work correctly

---

## 1. What runs locally

The current local stack is:

- Postgres
- Redis
- Prisma migrate step
- apps/web

For now, keep `control-plane-worker` disabled locally while testing the main project-create flow.
The create/provision flow works, but the worker currently performs premature cleanup after successful workspace bring-up.

---

## 2. Prerequisites

Before starting locally, make sure you have:

- Docker Desktop running
- an `.env` file at the repo root
- working AWS credentials for the local control plane
- Clerk keys configured for local use
- ngrok installed and logged in
- the fixed ngrok domain configured in Clerk

---

## 3. Required environment variables

Create a root `.env` file from your example file:

```bash
cp .env.example .env
```

At minimum, confirm these are set:

```env
NODE_ENV=development
NEXT_TELEMETRY_DISABLED=1

DATABASE_URL=postgresql://postgres:postgres@postgres:5432/spinup_local
REDIS_URL=redis://redis:6379

PROJECT_ARTIFACT_BUCKET=bolt-app-v1
AWS_REGION=ap-south-1
ASG_NAME=codeserver-autoscaling-group

AWS_AUTH_MODE=explicit
EC2_LAUNCHER_ACCESS_KEY=YOUR_AWS_ACCESS_KEY
EC2_LAUNCHER_ACCESS_SECRET=YOUR_AWS_SECRET_KEY

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=YOUR_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY=YOUR_CLERK_SECRET_KEY
```

### Important note about AWS credentials

The local control plane containers are not running on EC2, so they do not get instance-profile credentials automatically.

That means for local Compose, you should use:

```env
AWS_AUTH_MODE=explicit
```

and provide valid local AWS credentials.

The workspace runtime on EC2 can still rely on the launch-template / instance-role path.

---

## 4. Start the Clerk tunnel first

Before opening the app, start the fixed ngrok tunnel:

```bash
ngrok http --url=https://needlessly-classic-gator.ngrok-free.app 3000
```

### Why this matters

Without the tunnel, local Clerk auth/callbacks may not resolve correctly.

The current reliable local flow is:

1. start Docker Compose
2. start ngrok
3. open the ngrok URL, not raw localhost
4. sign in through Clerk
5. verify the user exists in the local DB before creating a project

---

## 5. Start the local stack

From the repo root:

```bash
docker compose up --build
```

Or in detached mode:

```bash
docker compose up -d --build
```

### Current local mode

For now, run the stack without `control-plane-worker` while testing project creation locally.

If your `docker-compose.yml` still contains the worker, either:
- comment it out temporarily, or
- start only the needed services

Example:

```bash
docker compose up -d postgres redis migrate web
```

---

## 6. Verify local services

Check that the local stack is healthy:

```bash
docker compose ps
docker compose logs migrate
docker compose logs web
```

Expected result:
- `postgres` is healthy
- `redis` is healthy
- `migrate` finishes successfully
- `web` stays up on port `3000`

---

## 7. Open the app through ngrok

Open:

```text
https://needlessly-classic-gator.ngrok-free.app
```

Do not use raw `http://localhost:3000` for the Clerk-authenticated flow unless you have confirmed your Clerk local config supports it.

---

## 8. Sign in and sync Clerk to the local DB

After opening the app through the ngrok URL:

1. sign in with Clerk
2. allow the auth flow to complete
3. verify the authenticated user exists in the local Postgres DB

### Open Postgres container

```bash
docker exec -it spinup-postgres sh
psql -U postgres -d spinup_local
```

### Check current database

```sql
SELECT current_database();
```

### Check users

```sql
SELECT id, "clerkId", email, name
FROM "User";
```

You should see a row for the Clerk user you just signed in with.

If that row is missing, the project route may fail with a message like:
- authenticated Clerk user not found in DB

Do not move on to project creation until the `User` row exists.

---

## 9. Create a project

Once the user is present in the DB:

1. open the app
2. create a project
3. watch the `web` logs

Useful command:

```bash
docker compose logs -f web
```

Expected high-level flow:
- project row created
- VM allocated
- public IP fetched
- VM agent becomes healthy
- container boot starts
- project becomes ready

---

## 10. Open the workspace

When the project is ready, open the workspace on the EC2 public IP:

```text
http://<EC2_PUBLIC_IP>:8080
```

If the workspace comes up, the main provisioning flow is working.

You may see a code-server warning about being accessed in an insecure context.
That is expected for the current HTTP-based local/demo flow.

---

## 11. Useful local commands

### Start stack
```bash
docker compose up --build
```

### Start without worker
```bash
docker compose up -d postgres redis migrate web
```

### Stop stack
```bash
docker compose down
```

### Stop and remove volumes
```bash
docker compose down -v
```

### View web logs
```bash
docker compose logs -f web
```

### Open Postgres
```bash
docker exec -it spinup-postgres sh
psql -U postgres -d spinup_local
```

### Open Redis
```bash
docker exec -it spinup-redis sh
redis-cli
```

---

## 12. Known local limitation

For now, `control-plane-worker` should remain disabled in local debug/demo mode.

Reason:
- the main provisioning path works
- but the worker currently performs aggressive cleanup after a successful workspace bring-up
- this can make the runtime disappear immediately after create

This is a known isolated issue in the worker / heartbeat path, not in the core provisioning flow.

---

## 13. Recommended local workflow

Use this exact order each time:

1. Start Docker Desktop
2. Start the local stack
3. Start ngrok
4. Open the ngrok URL
5. Sign in with Clerk
6. Verify the user exists in local Postgres
7. Create a project
8. Open the workspace at `IP:8080`

---

## 14. Troubleshooting

### Missing required environment variable: PROJECT_ARTIFACT_BUCKET
Make sure it exists in the `.env` file used by the running `web` container, then recreate the container.

### Authenticated Clerk user not found in DB
Run the ngrok tunnel, sign in again through the ngrok URL, then verify the `User` row exists in Postgres.

### Docker build fails with overlay/input-output errors
This is usually a local Docker cache/builder issue. Restart Docker Desktop and rebuild.

### Workspace appears, then disappears
Keep `control-plane-worker` disabled locally for now.

---

## 15. Current local demo mode summary

Use local Docker Compose for the control plane, ngrok for Clerk auth, and EC2 for the actual workspace runtime.

That is the intended local demo setup right now.
