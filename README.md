# HR App (AM service)

Production-ready HR portal with:
- Admin, business user, and staff roles
- 2FA login flow and password setup/reset links
- Staff document upload/download with access control
- In-app contract signing with signature merge into PDF
- Audit logging for key security-relevant actions

## What is implemented

- Security headers and JWT-based cookie auth
- Login rate limiting and failed-attempt tracking
- Admin-only audit endpoint: `GET /api/audit`
- Audit persistence to `./data/audit.log`
- App state persistence to `./data/db.json`
- S3-backed document storage (with local filesystem fallback)
- SMTP/SES/dev-console email modes
- Docker support via `Dockerfile`
- GitHub Actions workflow to build/push image and trigger ECS rollout

## Local run

Install dependencies:

```bash
npm install
```

Build frontend:

```bash
npm run build
```

Start API/UI server:

```bash
node server.js
```

Run smoke test:

```bash
node scripts/smoke-test.mjs
```

Run production dependency vulnerability scan:

```bash
npm audit --omit=dev
```

## Environment variables

Required:
- `JWT_SECRET`
- `APP_URL`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Email options:
- SMTP mode:
	- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- SES mode:
	- `USE_SES=true`
	- `AWS_REGION`
	- `SES_FROM` (or `SMTP_FROM`)
- Dev fallback mode:
	- `DEV_EMAIL_TO_CONSOLE=true`

S3 documents (optional but recommended for AWS):
- `S3_BUCKET`
- `AWS_REGION`
- IAM role/credentials with S3 access

## AWS deployment guide

### 1) Prerequisites on your machine

Install:
- Docker Desktop
- AWS CLI v2

Configure AWS CLI:

```bash
aws configure
aws sts get-caller-identity
```

### 2) Create AWS resources

- ECR repository (for app image)
- ECS cluster + service (Fargate)
- Application Load Balancer
- S3 bucket for staff documents
- (Recommended) RDS for long-term relational persistence
- ACM certificate + Route53 DNS record

### 3) GitHub repository secrets

Set these in GitHub Actions secrets:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `ECR_REPOSITORY`
- `ECS_CLUSTER`
- `ECS_SERVICE`

Runtime app secrets (set in ECS task definition or parameter store):
- `JWT_SECRET`
- `APP_URL`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `S3_BUCKET`
- SMTP or SES variables

### 4) Deploy

Push to `main` branch. The workflow in `.github/workflows/deploy.yml` will:
- Build Docker image
- Push image to ECR
- Trigger ECS service redeploy

### 5) Post-deploy checks

- Verify health endpoint/API access
- Verify login + 2FA delivery
- Upload/download a staff document
- Sign a contract and download merged PDF
- Confirm audit events via admin `GET /api/audit`

## Security notes

- In production, the app exits if `JWT_SECRET` is missing or default.
- Keep `DEV_EMAIL_TO_CONSOLE=false` in production.
- Restrict who can access S3 bucket objects via IAM.
- Rotate SMTP/SES credentials and JWT secret regularly.

## Current persistence model

Current implementation persists app state to local disk (`./data/db.json`) and audit to `./data/audit.log`.

For multi-instance AWS deployments, migrate persistent data to RDS (or another managed database). S3 is already supported for document binaries.
