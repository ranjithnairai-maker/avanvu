#!/usr/bin/env bash
# Idempotent per-environment setup for Google Cloud (SPEC §9.4, D-19: region us-east4).
# Usage: infra/setup.sh <preview|production> <gcp-project-id>
#
# Creates (or leaves alone, if present): APIs, Artifact Registry, service accounts, Cloud KMS key with 90-day
# rotation (encrypter/decrypter granted on this one key only), empty Secret Manager secrets, Cloud Tasks queues.
# It NEVER writes secret values: add versions yourself with `gcloud secrets versions add`.
# UNVERIFIED: written without access to a GCP project. Run with --dry-run first and read the output.
set -euo pipefail

ENVIRONMENT="${1:?usage: setup.sh <preview|production> <gcp-project-id> [--dry-run]}"
PROJECT="${2:?usage: setup.sh <preview|production> <gcp-project-id> [--dry-run]}"
DRY="${3:-}"
REGION="us-east4"
case "$ENVIRONMENT" in preview|production) ;; *) echo "environment must be preview or production" >&2; exit 2;; esac

run() { if [ "$DRY" = "--dry-run" ]; then echo "+ $*"; else "$@"; fi; }
exists() { if [ "$DRY" = "--dry-run" ]; then return 1; else "$@" >/dev/null 2>&1; fi; }

SA_API="avanvu-api@${PROJECT}.iam.gserviceaccount.com"
SA_WORKER="avanvu-worker@${PROJECT}.iam.gserviceaccount.com"
SA_TASKS="avanvu-tasks-invoker@${PROJECT}.iam.gserviceaccount.com"
SA_SCHED="avanvu-scheduler@${PROJECT}.iam.gserviceaccount.com"
KEYRING="avanvu-${ENVIRONMENT}"
KEY="user-data-keys"

echo "== APIs"
run gcloud services enable run.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com \
  cloudkms.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
  --project "$PROJECT"

echo "== Artifact Registry"
exists gcloud artifacts repositories describe avanvu --location "$REGION" --project "$PROJECT" || \
  run gcloud artifacts repositories create avanvu --repository-format=docker --location "$REGION" --project "$PROJECT"

echo "== Service accounts (no key files, ever)"
for sa in avanvu-api avanvu-worker avanvu-tasks-invoker avanvu-scheduler; do
  exists gcloud iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT" || \
    run gcloud iam service-accounts create "$sa" --project "$PROJECT"
done

echo "== Cloud KMS: one key, 90-day rotation, API and worker only"
exists gcloud kms keyrings describe "$KEYRING" --location "$REGION" --project "$PROJECT" || \
  run gcloud kms keyrings create "$KEYRING" --location "$REGION" --project "$PROJECT"
exists gcloud kms keys describe "$KEY" --keyring "$KEYRING" --location "$REGION" --project "$PROJECT" || \
  run gcloud kms keys create "$KEY" --keyring "$KEYRING" --location "$REGION" --purpose encryption \
    --rotation-period 90d --next-rotation-time "$(date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)" --project "$PROJECT"
for sa in "$SA_API" "$SA_WORKER"; do
  run gcloud kms keys add-iam-policy-binding "$KEY" --keyring "$KEYRING" --location "$REGION" \
    --member "serviceAccount:${sa}" --role roles/cloudkms.cryptoKeyEncrypterDecrypter --project "$PROJECT"
done

echo "== Secret Manager (empty secrets; you add the versions)"
SECRETS=(SUPABASE_SECRET_KEY DATABASE_URL_API DATABASE_URL_WORKER ANTHROPIC_API_KEY ELEVENLABS_API_KEY
         REVENUECAT_SECRET_API_KEY REVENUECAT_WEBHOOK_AUTH APPLE_SIWA_PRIVATE_KEY EXPO_ACCESS_TOKEN
         SENTRY_DSN_API SENTRY_DSN_WORKER POSTHOG_API_KEY)
for s in "${SECRETS[@]}"; do
  exists gcloud secrets describe "$s" --project "$PROJECT" || \
    run gcloud secrets create "$s" --replication-policy=automatic --project "$PROJECT"
  for sa in "$SA_API" "$SA_WORKER"; do
    run gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:${sa}" \
      --role roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null
  done
done

echo "== Cloud Tasks queues (SPEC §9.3)"
exists gcloud tasks queues describe render --location "$REGION" --project "$PROJECT" || \
  run gcloud tasks queues create render --location "$REGION" --project "$PROJECT" \
    --max-concurrent-dispatches=10 --max-attempts=3 --min-backoff=30s --max-backoff=300s
exists gcloud tasks queues describe jobs --location "$REGION" --project "$PROJECT" || \
  run gcloud tasks queues create jobs --location "$REGION" --project "$PROJECT" \
    --max-concurrent-dispatches=20 --max-attempts=10 --min-backoff=10s --max-backoff=600s
# The 20-minute dispatch deadline is set per task by the API when it enqueues.

echo "== Invoker permissions"
run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${SA_API}" \
  --role roles/cloudtasks.enqueuer >/dev/null
run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${SA_WORKER}" \
  --role roles/cloudtasks.enqueuer >/dev/null
run gcloud iam service-accounts add-iam-policy-binding "$SA_TASKS" --member "serviceAccount:${SA_API}" \
  --role roles/iam.serviceAccountUser --project "$PROJECT" >/dev/null
run gcloud iam service-accounts add-iam-policy-binding "$SA_TASKS" --member "serviceAccount:${SA_WORKER}" \
  --role roles/iam.serviceAccountUser --project "$PROJECT" >/dev/null

cat <<EOF

Done (${ENVIRONMENT}). Next:
  1. Add secret versions:   printf '%s' "\$VALUE" | gcloud secrets versions add NAME --data-file=- --project ${PROJECT}
  2. Create billing alerts in the console (budget with 50/90/100 % thresholds).
  3. Build and push the image, then run infra/deploy.sh ${ENVIRONMENT} ${PROJECT} <image-tag>.
EOF
