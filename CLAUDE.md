# CLAUDE.md — Avanvu

Avanvu is an iOS app (Expo/React Native) that interviews adult athletes about an upcoming event and generates personalized, voiced, music-backed mental-rehearsal sessions they can play offline. Backend: one TypeScript service on Google Cloud Run (`api` + `worker`), Supabase for Auth/Postgres/Storage, Anthropic for language tasks, ElevenLabs for speech, RevenueCat for subscriptions.

## Source of truth

Read before working on anything:

| File | What it is |
| --- | --- |
| `docs/SPEC.md` | Product and technical requirements (behaviour, architecture, milestones) |
| `docs/CONTRACTS.md` | Schemas and state machines: profile, intake turn, timeline, judge, session/job states, ledger, idempotency, errors, encryption, analytics |
| `docs/EVALS.md` | Evaluation suites and release gates |
| `docs/DECISIONS.md` | Decisions made so far, open decisions with defaults, founder actions |

Precedence: CONTRACTS > SPEC > EVALS. A disagreement between them is a documentation bug: stop and ask.
`docs/history/` and `docs/reviews/` are context only. Never implement from them.

## Project resources

| Resource | Value |
| --- | --- |
| Repository | https://github.com/ranjithnairai-maker/avanvu.git (public, default branch `main`, CI on GitHub Actions) |
| Supabase organization | `avanvu` |
| Supabase production project | `avanvu`, ref `xgxhhnrtctaiixylzydv`, region `us-east-1` (North Virginia) |
| Production API URL | `https://xgxhhnrtctaiixylzydv.supabase.co` |
| Google Cloud region | `us-east4` (co-located with Supabase, D-19) |
| Supabase preview project | not created yet; ask the founder before any work that needs it |

Full table, including the JWKS URL and issuer: SPEC §9.4.1. The project ref and URLs are identifiers, not secrets. Because the repository is **public**, never commit API keys, database passwords, connection strings, `.env` files or real athlete data. Never run migrations or `supabase db push` against the production project from a development machine; production changes go through a reviewed release step.

## Environment facts

- The founder has an iPhone and **no Mac**. There is no iOS simulator. Native builds happen on EAS (`eas build --profile development --platform ios`). You cannot see the app run.
- So for every milestone, write `docs/device-tests/Mn.md`: numbered steps, expected results, and what to capture if it fails. The founder runs it and records results.
- Prefer logic that can be unit-tested outside the device (hooks, reducers, schedulers, players' state logic) and keep native-dependent code thin.

## Non-negotiables

1. **Scope.** Build only what SPEC defines. SPEC §16 exclusions are never scaffolded "for later".
2. **Single data path.** The mobile app uses Supabase only for sign-in. All data goes through the API. The `app` schema is never exposed through the Supabase Data API. No secret key ever ships in the app.
3. **Sensitive data (🔒 in CONTRACTS).** Encrypt only through `packages/core/crypto`. Never write athlete text, prompts, model outputs, transcripts, tokens or signed URLs to logs, analytics, Sentry, task payloads, URLs or test snapshots. Use the logger and analytics wrappers; never call `console.log` with data or the vendor SDKs directly.
4. **Untrusted model output.** Every model response is validated with Zod; profile updates are applied only to allowlisted paths; text from athletes is passed as data, never as instructions.
5. **Idempotency and durability.** Every mutating endpoint takes an `Idempotency-Key`. Worker steps take a lease and checkpoint. Assume every request, task and webhook can arrive twice.
6. **Authorization.** User-scoped queries run inside `withUserTx(userId, …)`. Worker and webhook code uses `withSystemTx(actor, …)`. New tables get grants, forced RLS, indexes and two-user isolation tests in the same change.
7. **Safety.** The deterministic safety screen runs before any intake or debrief model call. Never weaken the lexicon, crisis flow or eval thresholds to make a test pass.
8. **Configuration, not constants.** Model ids, effort levels, voice ids, TTS models, allowances, prices and cost caps come from config. Prices shown to users come from StoreKit/RevenueCat.
9. **Fictional data only** in fixtures, seeds, evals and screenshots.
10. **Pinned dependencies.** Use `npx expo install` for anything native; commit lockfiles; no `latest` tags; the worker image pins its base digest and ffmpeg build.
11. **Brand.** The product name is Avanvu. The retired name "Envision" must not appear anywhere user-visible or in configuration.

## Stop and ask the founder when

- documents conflict, or a requirement seems wrong or unsafe;
- a change would touch an exclusion, claims language, safety behaviour, retention, pricing or allowance semantics;
- you need a new vendor, service, paid plan or account, or secrets the founder has not provided (list exactly which);
- the only way forward is to weaken a test, threshold or security control;
- an open decision in `docs/DECISIONS.md` blocks the work and its default does not fit.

Otherwise make the simplest choice consistent with SPEC §7 and §12, record it in `docs/DECISIONS.md`, and continue.

## Repository layout (created in M1)

```
apps/mobile          Expo app (Expo Router)
apps/web             Next.js site: landing, Privacy, Terms, support, deletion info
services/backend     Node 22 service; src/api and src/worker entrypoints; one Dockerfile
packages/core        Zod contracts, prompts, sports registry, safety lexicon, crypto, TTS interface, brand config
packages/evals       Eval harnesses and fictional fixtures
supabase/            config.toml, migrations/, tests/ (pgTAP)
infra/               Idempotent per-environment setup for Cloud Run, Tasks, Scheduler, KMS, Secret Manager
docs/                SPEC, CONTRACTS, EVALS, DECISIONS, runbooks/, spikes/, device-tests/, eval-reports/, history/, reviews/
```

## Commands (implement in M1, keep this list current)

```
pnpm install
pnpm lint            # ESLint + Prettier check
pnpm typecheck       # tsc --noEmit across the workspace
pnpm test            # Vitest (core, backend), Jest + RNTL (mobile)
pnpm test:db         # supabase start + migrations + pgTAP
pnpm eval:smoke      # EVALS smoke suites (needs API keys; skips with a clear message without them)
pnpm dev:backend     # api + worker locally against the local Supabase stack and fake vendors
pnpm --filter mobile start   # Expo dev server for the development build
```

## How to work

- Work milestone by milestone (SPEC §15). Start each one by reading its exit criteria and writing a short plan in the PR description.
- Implement contracts first, with tests, then the code that uses them.
- Keep commits small and focused; one concern per commit.
- When you finish a milestone: CI green, device checklist written, runbooks added for new production behaviour, `docs/DECISIONS.md` updated, and a short summary of what remains uncertain.
- Definition of done: SPEC §15.1.
