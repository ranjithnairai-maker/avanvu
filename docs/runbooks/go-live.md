# Go-live checklist

The backend refuses to start in `preview` and `production` until every vendor adapter exists. The error names what is missing. This is deliberate: it is better to fail loudly at boot than to serve athletes from a stub.

## 1. Adapters still to implement (each is a thin file behind an existing port)

| Port | File | Needs |
| --- | --- | --- |
| Language model | `services/backend/src/ports/llm.ts` (`LlmClient`) | Anthropic API key. Structured outputs (`output_config.format`, type `json_schema`) with the JSON Schemas from `packages/core/src/jsonschema.ts`; effort from config; 40 s intake timeout; map 429/5xx/timeout to `LlmError`. Confirm the effort parameter name in the current API docs (D-13). |
| Text to speech | `packages/core/src/tts.ts` (`TtsProvider`) | ElevenLabs key. Return 16-bit PCM WAV (request a PCM output format); pass previous and next text for continuity; classify 429/5xx as retryable. Record the real characters billed. |
| Storage | `services/backend/src/ports/storage.ts` (`Storage`) | Supabase Storage with the secret key: private buckets `audio`, `jobs`, `exports`, `music`; signed URLs of 15 minutes. |
| Task queue | `services/backend/src/ports/queue.ts` (`TaskQueue`) | Cloud Tasks client with OIDC token (service account `avanvu-tasks-invoker`), task name from `TaskSpec.name`, 20-minute dispatch deadline for `render`. |
| Key wrapping | `services/backend/src/security/kms.ts` (`GcpKms`) | Cloud KMS encrypt/decrypt with AAD `user:{id}` using the Cloud Run identity. No key files. |
| Push | `services/backend/src/ports/push.ts` (`PushClient`) | Expo push service with `EXPO_ACCESS_TOKEN`; report invalid tokens. |
| Purchases | `services/backend/src/ports/vendors.ts` (`RevenueCatClient`) | RevenueCat REST (v2) customer lookup and delete. App user id is the Supabase user id. |
| Apple | `services/backend/src/ports/vendors.ts` (`AppleAuth`) | Sign in with Apple key (.p8): authorization-code exchange and token revocation. |
| Auth admin / analytics | `services/backend/src/ports/vendors.ts` (`AccountVendors`) | Supabase Auth admin API (sign out all, delete user) and PostHog person delete. |

Each adapter needs a contract test against its recorded vendor responses (never against live athlete data) before it is switched on in `composition.ts`.

## 2. Founder accounts and decisions (see `docs/DECISIONS.md`)

D-25 (legal entity, Apple developer account) blocks the production bundle id. D-27 (voices and music licences) blocks `voice_catalog` and `music_catalog` rows. D-21 (TTS model per context) and D-17/D-22 (economics) block `TTS_MODEL_*`, `TRIAL_SESSION_ALLOWANCE` and `COST_CAP_DAILY_USD`.

## 3. Order of operations

1. Create the preview GCP project and Supabase project (`us-east-1` / `us-east4`).
2. `infra/setup.sh preview <project> --dry-run`, read it, then run it. Add secret versions.
3. Apply `supabase/migrations/*` through the release process (never from a developer machine against production).
4. Seed `voice_catalog` and `music_catalog` with licensed assets; upload music WAVs to the private `music` bucket.
5. Build and push the image; `infra/deploy.sh preview <project> <tag>`.
6. Run the device checklists in `docs/device-tests/` against the preview build.
7. Repeat for production after the economics, legal and safety-review gates in SPEC §13.3, §12.8 and EVALS §7.

## 4. Known gaps recorded at the time of writing

- `POST /webhooks/apple-siwa` (Apple server-to-server notifications) is a *should* in SPEC §11.2 and is not built: it needs the Apple `sub` stored next to the refresh token (D-47).
- The pgTAP CI job has never run; the same checks run under PGlite in `pnpm test`.
- `infra/*.sh` were written without a GCP project: use `--dry-run`, then run step by step.
