# Avanvu — Decision Log

Every implementation choice not fixed by SPEC, CONTRACTS or EVALS is recorded here, newest last. Format for new entries:

```
## D-nn — Title (YYYY-MM-DD, status: decided | open | superseded by D-mm)
Context: why a decision was needed
Options: what was considered
Decision: what was chosen
Consequences: what this commits us to; how to revisit
```

Status **decided** entries below came from the 2026-10-11 technical review of the annotated plan; the founder may override any of them, but the override must be recorded here before code changes. Status **open** entries have a working default that Claude Code uses until the founder decides; anything marked *release gate* must be decided before public launch.

---

## Decided

### D-01 — Single TypeScript backend on Cloud Run; no Supabase Edge Functions (2026-10-11, decided)
Context: the annotated plan split server logic between Supabase Edge Functions (Deno) and a Cloud Run worker (Node). Both need the same encryption, schemas, prompts and safety rules. Edge Functions would also need long-lived Google service-account key files to call Cloud KMS and Cloud Tasks, and they have a 2 s CPU limit and a 150 s (free) / 400 s (paid) wall-clock limit.
Options: keep Edge Functions plus shared Deno/Node packages; move all trusted logic to Cloud Run.
Decision: one Node 22 TypeScript image, deployed as `api` (min 1 instance in production) and `worker` (min 0). Supabase remains Auth, Postgres and Storage.
Consequences: Cloud Run service identities reach KMS and Cloud Tasks with no key files; one runtime and one test toolchain; small fixed cost for the warm `api` instance.

### D-02 — Transactional outbox + Cloud Tasks; script generation inside the worker job (2026-10-11, decided)
Context: "attempt an authenticated HTTP invocation of Cloud Run" leaves a multi-minute render dependent on a caller that cannot wait for it; script generation in the request path risked request timeouts and lost work on disconnect.
Decision: work rows + outbox in the same transaction; Cloud Tasks with OIDC delivers to the worker (retries, back-off, up to 30-minute dispatch deadline, concurrency limits that protect vendor quotas); a 1-minute sweeper re-enqueues undispatched rows; leases and checkpoints make duplicates harmless. The whole pipeline (script, validation, judge, synthesis, mix) runs in the worker job.
Consequences: `POST /v1/sessions` returns in milliseconds; one durable state machine (CONTRACTS §8).

### D-03 — API is the only data path; `app` schema not exposed; forced RLS as defense in depth (2026-10-11, decided)
Context: with direct client reads through the Supabase Data API, any RLS policy that lets the backend write "as the user" also lets the mobile client write the same rows directly, bypassing server validation and encryption.
Decision: tables live in schema `app`, removed from the Data API; `anon`/`authenticated` have no privileges; the app uses Supabase only for sign-in. Backend roles have no BYPASSRLS; policies key on a per-transaction `app.user_id` setting.
Consequences: one authorization boundary to test; status updates come by polling the API and push (D-08).

### D-04 — Envelope encryption with Cloud KMS and per-user data keys (2026-10-11, decided)
Context: the plan required application-level encryption but left the key hierarchy, rotation and access path open, with an escape hatch to skip it.
Decision: CONTRACTS §12. Feasible without key files because of D-01.
Consequences: support tooling sees metadata only; backups still contain wrapped keys, so deletions rely on backup expiry plus the deletion ledger replay.

### D-05 — Sign in with Apple + email one-time code; Apple tokens captured for revocation (2026-10-11, decided)
Context: the plan left "Apple only or Apple plus magic link" open. Magic links on iOS need universal links and are often consumed by email link scanners before the athlete taps them. Supabase's native Sign in with Apple flow does not store Apple refresh tokens or revoke them on deletion.
Decision: Sign in with Apple (native, nonce) plus email 6-digit code via Supabase Auth with a transactional email provider as custom SMTP. The app sends Apple's authorization code to `POST /v1/auth/apple/link` immediately after sign-in; the API exchanges it, stores the refresh token encrypted, and revokes it during deletion.
Consequences: no universal-link setup needed in v1; an extra Apple key (.p8) and an SMTP account are required.

### D-06 — Age assurance with Apple Declared Age Range before account creation (2026-10-11, decided)
Context: Texas, Utah and Louisiana app-store age laws are in force in 2026 and Apple directs developers to its age-range signals; a self-declared checkbox alone is no longer enough for an 18+ product in those states.
Decision: `expo-age-range` with minimum age 18, fallback rules in SPEC §12.5.
Consequences: requires the entitlement and Xcode 26+ builds; drives D-18.

### D-07 — No streaming in intake v1 (2026-10-11, decided)
Decision: the server commits the complete validated turn, returns it, and the client reveals it progressively. Removes partial-JSON and reconnect edge cases.

### D-08 — Polling plus push for session status; no Supabase Realtime (2026-10-11, decided)
Decision: poll `GET /v1/sessions/:id` while the composing screen is visible (3 s, backing off to 10 s); push on ready. Consistent with D-03.

### D-09 — Local notifications for reminders; server push only for ready and readiness nudges (2026-10-11, decided)
Decision: SPEC §9.6. Reminders fire offline and in the event's time zone without server scans.

### D-10 — Duration fitting with elastic pauses; fixed rehearse silences (2026-10-11, decided)
Context: a ±5 % post-render tolerance with no defined remedy would force re-synthesis (paying TTS twice).
Decision: CONTRACTS §6.2. Real-time `rehearse` silences are never changed.

### D-11 — Transcripts derived from the stored script (2026-10-11, decided)
Decision: no separate transcript column; one encrypted source of truth.

### D-12 — Kysely + pg, SQL migrations through the Supabase CLI, pgTAP (2026-10-11, decided)
Decision: typed queries with Kysely; schema, roles, grants and policies in plain SQL migrations; pgTAP for policy tests; Supavisor transaction pooler (prepared statements off).

### D-13 — Model configuration per task (2026-10-11, decided)
Decision: defaults `LLM_MODEL_INTAKE=claude-sonnet-5-5` at low effort, `LLM_MODEL_SCRIPT=claude-sonnet-5-5` at medium effort, `LLM_MODEL_JUDGE=claude-haiku-5-5`, `LLM_MODEL_DEBRIEF=claude-sonnet-5-5` at low effort. These ids are current per Anthropic's models overview (checked 2026-10-11); the earlier critical review's claim that they did not exist was incorrect. Claude structured outputs (`output_config.format`) for every model call. Prompt caching for system and engine prompts. Moving intake to Haiku 5.5 is allowed only if the intake eval gates pass. Confirm the exact effort parameter in the current API docs during M2.

### D-14 — Bundled non-personalized backup primer (2026-10-11, decided)
Context: the highest-value moments (night before, start line) are the worst moments for an outage or missing download.
Decision: one reviewed 3-minute primer per voice ships in the app binary, labelled "not personalized", free for everyone.
Consequences: ~6 MB of audio in the bundle; script written and reviewed by the content reviewer (D-30).

### D-15 — Special sessions generated at T−72 h with allowance held (2026-10-11, decided)
Decision: SPEC §5.2 and CONTRACTS §11. Pro on-demand allowance excludes sessions held for upcoming special items; the free primer grant can only be used by an event's scheduled primer.

### D-16 — Rate limits in Postgres (2026-10-11, decided)
Decision: token buckets in `app.rate_limit_buckets` with atomic upsert; no new vendor.

### D-31 — Music chosen by style; server picks the track (2026-10-11, decided)
Context: the annotated plan left "any track or only a style" open.
Decision: the athlete chooses a style or voice only; the server picks a licensed track in that style. Keeps the UI simple and the licence surface small.

### D-32 — Paywall shown on paid actions, not as a step after the first check-in (2026-10-11, decided)
Context: the original plan showed the paywall right after the first check-in while still promising a free primer; the annotated plan's first-run flow dropped that step.
Decision: a non-blocking upgrade card on Home after the first check-in; the paywall itself appears when the athlete attempts a paid action.

### D-19 — Hosting region: North Virginia (2026-10-11, decided by founder action)
Context: the review's default was Montréal, but the founder created the production Supabase project in `us-east-1` (North Virginia), project ref `xgxhhnrtctaiixylzydv`.
Decision: co-locate Google Cloud in `us-east4` (Northern Virginia) for Cloud Run, Cloud Tasks, Cloud Scheduler and Cloud KMS. The preview Supabase project should also use `us-east-1`.
Consequences: all athlete data is stored and processed in the United States; the Privacy Policy and consent screen say so (SPEC §9.4, §12.4). A Supabase project's region cannot be changed after creation; if Canadian data residency becomes a requirement, create a new project before any real athlete data exists and update this entry.

### D-33 — Source control and CI (2026-10-11, decided)
Decision: the code lives at https://github.com/ranjithnairai-maker/avanvu (default branch `main`); CI runs on GitHub Actions with secret scanning enabled. The repository is public at the time of writing, so it must never contain secrets, real athlete data or `.env` files.
Consequences: the specifications, prompts and safety lexicon are visible to anyone while the repository stays public. The founder may make it private at any time; nothing in the build depends on visibility.

### D-34 — Local tooling: pnpm via npm, Node 22 target, hoisted node_modules (2026-10-11, decided)
Context: `corepack enable` needs administrator rights on the founder's Windows machine; the machine runs Node 24 while the backend targets Node 22; Expo and pnpm's isolated layout conflict in monorepos.
Decision: install pnpm with `npm i -g pnpm@10.18.3` (pinned in `packageManager`); `.nvmrc` and CI use Node 22, `engines` allows 22 to 24 so local Node 24 works; `.npmrc` sets `node-linker=hoisted` for Expo.
Consequences: CI is the Node 22 source of truth. The worker image will pin Node 22.

### D-35 — Temporary iOS bundle identifier for development builds (2026-10-11, decided; founder action required)
Context: EAS needs a bundle identifier for the first development build, but D-25 (legal entity, Apple developer account type) is still open.
Decision: `apps/mobile/app.config.ts` reads `AVANVU_BUNDLE_ID` and otherwise falls back to the placeholder `com.example.avanvu.dev`, which cannot be registered. Before the first `eas build`, the founder sets a development identifier they control in their EAS environment. The production identifier is chosen once D-25 is decided and never changes after release.
Consequences: no production identifier is committed.

### D-36 — Dictation candidate: expo-speech-recognition (2026-10-11, decided, pending spike d)
Decision: `expo-speech-recognition` 57.1.1 (SDK 57 compatible) is installed for the dictation spike. The microphone is shown only when recognition is available, on-device recognition is supported and the `en-US` locale is installed (`dictationAvailable` in core). If the spike fails on the founder's device, drop dictation and ship text only (SPEC §4.4).

### D-37 — TypeScript versions (2026-10-11, decided)
Decision: packages and tooling use TypeScript 5.9.3. The Expo SDK 57 template pins `~6.0.3`, so `apps/mobile` keeps that and the two are checked separately by `pnpm typecheck`. Unify when SDK 58 lands.

### D-38 — Seed safety lexicon (2026-10-11, decided, reviewer sign-off required)
Context: SPEC §12.2 needs a reviewed lexicon and idiom allowlist before any model call.
Decision: `packages/core/src/safety/lexicon.ts` ships a seed set with fictional red-team items in `lexicon.test.ts`. It is versioned (`LEXICON_VERSION`) and is **not** approved for beta. The content reviewer (D-30) finalises it; changes run the full safety eval set. Known deliberate allowlist cases include "suicide sprints" in training contexts.

### D-39 — Source layout inside packages/core (2026-10-11, decided)
Decision: modules live in `packages/core/src/` (for example `src/brand.ts`, `src/sports.ts`, `src/crypto.ts`, `src/safety/lexicon.ts`) and are exported from `src/index.ts`. The paths in CLAUDE.md and SPEC (for example `packages/core/brand.ts`) are read as "in the core package".

### D-40 — ffmpeg pinned by archive hash, first-seen (2026-10-11, decided; verify before release)
Context: the worker image must pin its ffmpeg build (CLAUDE.md 10).
Decision: `services/backend/Dockerfile` installs the static build `ffmpeg-7.0.2-amd64-static.tar.xz` from johnvansickle.com and verifies SHA-256 `abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67`, which is the hash of the file as first downloaded on 2026-10-11 (the vendor publishes only MD5, and its sidecar was unavailable). The Node base image is pinned to `node:22.20.0-bookworm-slim@sha256:b21fe589…`. Tests use the `ffmpeg-static` npm package (ffmpeg 6.1.1).
Consequences: before the first production release, compare the hash with an independent source or switch to a build whose checksums the vendor signs; loudness and duration tests must pass on the production build.

### D-41 — Real Postgres in tests through PGlite; pgTAP in CI (2026-10-11, decided)
Decision: unit and integration tests run the real SQL migrations on PGlite (WASM Postgres), assuming the `avanvu_api` and `avanvu_worker` roles with `set local role`, so forced RLS, grants and constraints are exercised without Docker. `supabase/tests/database/rls.test.sql` (pgTAP) runs against the real stack in a non-blocking CI job until it has been seen green once. The Data API exposure test (SPEC §10.2) needs the Supabase stack and exists only as the `schemas` setting in `supabase/config.toml` plus the `anon`/`authenticated` privilege assertions.

### D-42 — Vendor adapters are placeholders; preview and production refuse to start (2026-10-11, decided)
Context: the founder asked for placeholders for the vendor APIs.
Decision: every vendor sits behind a port with a fake (tests, local) and an `Unconfigured*` placeholder. `composition.ts` throws `UnimplementedAdaptersError` in `preview` and `production`, naming what is missing, instead of serving from stubs. The adapter list and order of operations are in `docs/runbooks/go-live.md`.

### D-43 — Sensitive values are sealed before a transaction opens (2026-10-11, decided)
Context: sealing may need a data-key lookup; doing that inside a transaction holds two pooled connections per request and deadlocks under load (found by a test).
Decision: callers take a `UserSealer` from `Sealer.forUser(userId)` before any transaction and use it inside. Idempotent responses are sealed because they can contain athlete text.

### D-44 — Idempotency stale takeover and replay of failures (2026-10-11, decided)
Decision: a request still `processing` after 2 minutes is treated as crashed and can be taken over by the same key. A handler failure releases the claim so the same key can be retried. Safety interruptions (409) are stored as results so a replay returns the same answer.

### D-45 — Scheduler and program details not fixed by SPEC (2026-10-11, decided)
Decision: night-before is kept in a program while now is before 22:00 local the evening before; training sessions sit between tomorrow and three days before the event; an item whose allowance is insufficient becomes `locked` and the athlete gets one `generation_blocked` push (free users' night-before is locked silently); offline nudges are one push per (kind, session) with kinds `offline_nudge_48h` and `offline_nudge_24h`; render jobs whose task was lost are re-dispatched under a new generation after 10 minutes.

### D-46 — Interview details not fixed by CONTRACTS (2026-10-11, decided)
Decision: interview "targets reached" means every phase target in SPEC §4.2 is resolved (optional fields `objective.desired_outcome`, `objective.why_now`, `scene.smells`, and sensitive fields never block). Past a turn or time cap with the minimum unmet, the server asks only for missing essentials, at most twice each, then moves to the summary. Crisis turns retain no text. Raw intake turns are encrypted with the turn id as AAD row id. The follow-up counter increments for the path the question targets, chosen by the server from the model's `next_focus`.

### D-47 — Sign in with Apple server notifications deferred (2026-10-11, decided)
Context: SPEC §11.2 lists `POST /webhooks/apple-siwa` as *should*. Apple's notifications identify users by the Apple `sub`, which is not the Supabase user id.
Decision: not built in this pass. It needs the Apple `sub` stored with the refresh token at link time (`POST /auth/apple/link` already receives the code) and Apple's signed-payload verification. Revisit before beta.

### D-48 — Local development uses a deterministic dev model (2026-10-11, decided)
Decision: `AVANVU_ENV=local` uses `DevLlm` (fills fields from the athlete's words, writes a valid script with the fixture builder, passes the judge), `FakeTtsProvider`, file storage and an in-process queue, so the whole loop runs with no keys. It is never constructed outside local.

---

## Open (working defaults in force until the founder decides)

| ID | Decision | Default Claude Code uses | Gate |
| --- | --- | --- | --- |
| D-17 | Trial allowance for the 7-day annual trial | `TRIAL_SESSION_ALLOWANCE=3`, topped up to 12 on conversion | release gate (economics, SPEC §13.2) |
| D-18 | Minimum iOS version | 26.0 (Declared Age Range always available; Xcode 26 is required anyway) | before M3 |
| D-20 | Launch storefronts | Canada and United States, English | before soft launch |
| D-21 | TTS model per context | ElevenLabs Multilingual for all contexts until the M1 blind test; Flash wherever it is judged equivalent | M1 result |
| D-22 | Annual-plan economics lever (price, monthly allowance, or minute-based allowance) | plan values ($79.99, 12 sessions/month) | release gate |
| D-23 | Raw intake transcript retention | delete 90 days after summary confirmation | before beta |
| D-24 | Vendor data retention (Anthropic zero data retention where eligible; ElevenLabs zero-retention is enterprise-only) | request Anthropic ZDR; disclose standard ElevenLabs retention | before beta |
| D-25 | Legal entity and Apple developer account type | none; blocks production App Store record and bundle id | before M3 production config |
| D-26 | Free-tier device limit with Apple DeviceCheck | implement in M9 | before public launch |
| D-27 | The three voices and the 8–12 tracks, with licences | none; M1 spike uses ElevenLabs library voices for testing only | before beta |
| D-28 | App Review sign-in approach | reviewers use Sign in with Apple on the free plan; demo accounts only for investor demos | before submission |
| D-29 | Crisis resource text per storefront | 9-8-8 (call or text) and emergency services for Canada and the US, pending reviewer approval | before beta |
| D-30 | Qualified content and safety reviewer | none; required for the red-team set, backup primer and launch-readiness reviews | before beta |

---

## Founder actions (M0, outside Claude Code)

- [ ] Register `avanvu.com` and `avanvu.app` with renewal protection and restricted registrar access; branded support address.
- [ ] Trademark clearance decision (CIPO, USPTO) for **Avanvu**.
- [ ] Legal entity (D-25), Apple Developer Program membership under it, App Store Connect record accepting the name **Avanvu**, bundle id.
- [x] GitHub repository created: https://github.com/ranjithnairai-maker/avanvu (D-33).
- [x] Supabase organization `avanvu` and production project `avanvu` created (ref `xgxhhnrtctaiixylzydv`, `us-east-1`).
- [ ] In the production project: enable asymmetric JWT signing keys (Settings → JWT Keys); keep the Data API exposing only its default schemas (never add `app`, D-03); upgrade to the Pro plan before the TestFlight beta (Free projects pause when inactive and lack the daily backups SPEC §10.4 relies on).
- [ ] Create the preview Supabase project in `us-east-1` (Free plan is fine) with the same settings.
- [ ] Decide whether the GitHub repository stays public (D-33).
- [ ] Expo account and EAS; two GCP projects (preview, production) in `us-east4` with Cloud Run, Cloud Tasks, Cloud Scheduler, Cloud KMS, Secret Manager, Artifact Registry and billing alerts.
- [ ] Anthropic API organization (request ZDR, D-24); ElevenLabs account and plan; RevenueCat project with App Store products; Sentry and PostHog projects; transactional email provider for Supabase custom SMTP.
- [ ] Apple keys: Sign in with Apple key (.p8), DeviceCheck key (D-26), App Store Connect API key for EAS Submit.
- [ ] Voices and music licences (D-27); content reviewer engaged (D-30); lawyer engaged for SPEC §12.8.

---

## Change log

- 2026-10-11 — Log created from the technical review; D-01 to D-16, D-31, D-32 decided; D-17 to D-30 open with defaults.
- 2026-10-11 — D-19 decided (North Virginia) after the founder created the production Supabase project in `us-east-1`; D-33 added for the GitHub repository and CI; founder actions updated.
