# Upload Base App to S3

This script uploads your pre-configured base apps (such as `react`, `nextjs`, `expo`) to an Amazon S3 bucket (`bolt-app`) so that they can later be pulled into autoscaled VMs or other deployment environments.

---

## Prerequisites

- Node.js and `npm` installed
- AWS account with permission to manage IAM users and S3
- [Bun](https://bun.sh) installed (if you're using Bun for script execution)
- A `.env` file in the root of the monorepo (you’ll create it below)

---

## Setup AWS Access

### 1. Create IAM User Group

1. Go to [AWS IAM Console → User groups](https://console.aws.amazon.com/iamv2/home#/groups).
2. Click **Create group**.
3. Enter a group name:  
   ```
   bolt-app-deployers
   ```
4. Attach the following permission policy:  
   ```
   AmazonS3FullAccess
   ```
5. Click **Create group**.

---

### 2. Create IAM User and Assign to Group

1. Go to [AWS IAM Console → Users](https://console.aws.amazon.com/iamv2/home#/users).
2. Click **Add users**.
3. User name:  
   ```
   bolt-deployer
   ```
4. Select **Access key - Programmatic access**.
5. Click **Next** → **Add user to group**, and select:  
   ```
   bolt-app-deployers
   ```
6. Click through to finish creating the user.

---

### 3. Get Access Keys

1. After creating the user, you'll see the **Access key ID** and **Secret access key**.
2. Save these in your project root `.env` file:

```
# .env
AWS_S3_USER_ACCESS_KEY=your-access-key-id
AWS_S3_USER_SECRET_ACCESS=your-secret-access-key
```

---

## ⚙️ Install Dependencies

From the root of your monorepo, run:

```bash
npm install
```

Or if you’re using `bun`:

```bash
bun install
```

---

## Upload the Base App

Once your credentials are set and dependencies installed, run:

```bash
bun run upload:base
```

This command will:

- Recursively read the contents of the `base-app/` directory
- Skip common ignored folders like `node_modules`, `.next`, `dist`, etc.
- Upload all files to S3 under the path `base-app/` in bucket `bolt-app`
- Create the bucket automatically if it doesn't exist

---

