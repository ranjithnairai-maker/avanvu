#!/usr/bin/env bash
# Deploys the single backend image as two Cloud Run services plus the Cloud Scheduler jobs (SPEC §9.1, §9.3).
# Usage: infra/deploy.sh <preview|production> <gcp-project-id> <image-tag> [--dry-run]
#
# A reviewed release step: never run `supabase db push` or migrations from here (CLAUDE.md). Apply migrations
# through the release process first. UNVERIFIED: written without access to a GCP project.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <preview|production> <gcp-project-id> <image-tag> [--dry-run]}"
PROJECT="${2:?missing project}"
TAG="${3:?missing image tag}"
DRY="${4:-}"
REGION="us-east4"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/avanvu/backend:${TAG}"
run() { if [ "$DRY" = "--dry-run" ]; then echo "+ $*"; else "$@"; fi; }

SA_API="avanvu-api@${PROJECT}.iam.gserviceaccount.com"
SA_WORKER="avanvu-worker@${PROJECT}.iam.gserviceaccount.com"
SA_TASKS="avanvu-tasks-invoker@${PROJECT}.iam.gserviceaccount.com"
SA_SCHED="avanvu-scheduler@${PROJECT}.iam.gserviceaccount.com"
KMS_KEY="projects/${PROJECT}/locations/${REGION}/keyRings/avanvu-${ENVIRONMENT}/cryptoKeys/user-data-keys"

# Non-secret configuration. Model ids and effort come from configuration, never code (CLAUDE.md 8).
COMMON_ENV="AVANVU_ENV=${ENVIRONMENT},KMS_KEY_NAME=${KMS_KEY},TASKS_QUEUE_RENDER=render,TASKS_QUEUE_JOBS=jobs"
COMMON_ENV+=",LLM_MODEL_INTAKE=${LLM_MODEL_INTAKE:-claude-sonnet-5-5},LLM_EFFORT_INTAKE=${LLM_EFFORT_INTAKE:-low}"
COMMON_ENV+=",LLM_MODEL_SCRIPT=${LLM_MODEL_SCRIPT:-claude-sonnet-5-5},LLM_EFFORT_SCRIPT=${LLM_EFFORT_SCRIPT:-medium}"
COMMON_ENV+=",LLM_MODEL_JUDGE=${LLM_MODEL_JUDGE:-claude-haiku-5-5},LLM_MODEL_DEBRIEF=${LLM_MODEL_DEBRIEF:-claude-sonnet-5-5}"
COMMON_ENV+=",TTS_MODEL_TRAINING=${TTS_MODEL_TRAINING:?set TTS_MODEL_TRAINING (D-21)},TTS_MODEL_NIGHT_BEFORE=${TTS_MODEL_NIGHT_BEFORE:?set TTS_MODEL_NIGHT_BEFORE},TTS_MODEL_PRIMER=${TTS_MODEL_PRIMER:?set TTS_MODEL_PRIMER}"
COMMON_ENV+=",COST_CAP_DAILY_USD=${COST_CAP_DAILY_USD:?set COST_CAP_DAILY_USD},PRO_MONTHLY_ALLOWANCE=12,TRIAL_SESSION_ALLOWANCE=${TRIAL_SESSION_ALLOWANCE:-3},FREE_TRAINING_GRANT=1,FREE_PRIMER_GRANT=1"
COMMON_ENV+=",SUPABASE_URL=${SUPABASE_URL:?},SUPABASE_JWKS_URL=${SUPABASE_URL}/auth/v1/.well-known/jwks.json,SUPABASE_JWT_ISSUER=${SUPABASE_URL}/auth/v1"
COMMON_ENV+=",TASKS_INVOKER_SA=${SA_TASKS}"

SECRETS="SUPABASE_SECRET_KEY=SUPABASE_SECRET_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,ELEVENLABS_API_KEY=ELEVENLABS_API_KEY:latest"
SECRETS+=",REVENUECAT_SECRET_API_KEY=REVENUECAT_SECRET_API_KEY:latest,REVENUECAT_WEBHOOK_AUTH=REVENUECAT_WEBHOOK_AUTH:latest"

echo "== worker (min 0, concurrency 2, 2 vCPU, 2 GiB, 20 minute timeout, private)"
run gcloud run deploy "avanvu-worker-${ENVIRONMENT}" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$SA_WORKER" --no-allow-unauthenticated \
  --min-instances 0 --concurrency 2 --cpu 2 --memory 2Gi --timeout 1200 \
  --set-env-vars "${COMMON_ENV},AVANVU_ROLE=worker" \
  --set-secrets "${SECRETS},DATABASE_URL_WORKER=DATABASE_URL_WORKER:latest,DATABASE_URL_API=DATABASE_URL_WORKER:latest"
WORKER_URL="$(if [ "$DRY" = "--dry-run" ]; then echo https://worker.example; else gcloud run services describe "avanvu-worker-${ENVIRONMENT}" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'; fi)"
run gcloud run services add-iam-policy-binding "avanvu-worker-${ENVIRONMENT}" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${SA_TASKS}" --role roles/run.invoker

echo "== api (min 1 in production)"
MIN=$([ "$ENVIRONMENT" = "production" ] && echo 1 || echo 0)
run gcloud run deploy "avanvu-api-${ENVIRONMENT}" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "$SA_API" --allow-unauthenticated \
  --min-instances "$MIN" --cpu 1 --memory 1Gi \
  --set-env-vars "${COMMON_ENV},AVANVU_ROLE=api,WORKER_BASE_URL=${WORKER_URL},SCHEDULER_SA=${SA_SCHED}" \
  --set-secrets "${SECRETS},DATABASE_URL_API=DATABASE_URL_API:latest,DATABASE_URL_WORKER=DATABASE_URL_WORKER:latest"
API_URL="$(if [ "$DRY" = "--dry-run" ]; then echo https://api.example; else gcloud run services describe "avanvu-api-${ENVIRONMENT}" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'; fi)"
run gcloud run services update "avanvu-api-${ENVIRONMENT}" --project "$PROJECT" --region "$REGION" \
  --update-env-vars "API_BASE_URL=${API_URL}"

echo "== Cloud Scheduler: outbox sweep (1 min) and scheduler tick (5 min), OIDC to the API"
for job in "outbox-sweep|* * * * *|/internal/outbox/sweep" "schedule-tick|*/5 * * * *|/internal/schedule/tick"; do
  IFS='|' read -r name cron path <<<"$job"
  if gcloud scheduler jobs describe "avanvu-${name}-${ENVIRONMENT}" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 && [ "$DRY" != "--dry-run" ]; then verb=update; else verb=create; fi
  run gcloud scheduler jobs "$verb" http "avanvu-${name}-${ENVIRONMENT}" --location "$REGION" --project "$PROJECT" \
    --schedule "$cron" --uri "${API_URL}${path}" --http-method POST \
    --oidc-service-account-email "$SA_SCHED" --oidc-token-audience "$API_URL"
done
echo "Deployed ${IMAGE} to ${ENVIRONMENT}."
