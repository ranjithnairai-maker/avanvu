# Avanvu — Technical Review of the Annotated Plan

**Date:** 2026-10-11
**Reviewed:** `Avanvu — Updated Business & Technical Plan (Annotated).md` (the forward plan), read together with `Avanvu — Critical Review and Recommendations.md` and the original `Envision — Business & Technical Plan` (which the annotated plan says stays in force wherever it is silent).
**Lens:** technical. Would a coding agent, given these files, build something that is correct, secure, reliable and affordable, without inventing important behaviour?
**Addendum (same day):** the founder created the repository (https://github.com/ranjithnairai-maker/avanvu) and the production Supabase project in `us-east-1`, so the Montréal region default mentioned below is superseded: D-19 is now decided as North Virginia (DECISIONS D-19, D-33).
**Rule followed:** change only what is necessary. Product decisions the founder made (sport scope, full interview, three voices, 8–12 tracks, iOS only, pricing hypotheses) are kept unless they create a technical defect, and in that case the defect is fixed with the smallest change and the product question is flagged rather than decided.

---

## Verdict

The annotated plan is a large improvement on the original. Its product scope is coherent, it takes safety and privacy seriously, and most of the critical review's points were absorbed well (outbox, idempotency, usage ledger, envelope encryption, structured debrief, explicit exclusions).

It was not yet safe to hand to Claude Code, for three kinds of reasons:

1. **It was not self-contained.** It said the original plan remains in force wherever it is silent, but Claude Code would not have the original. The whole design system, the audio parameters, the script-writing rules and most screen specs existed only in the original.
2. **Several load-bearing mechanisms were described as intentions rather than designs**: where script generation runs, how a multi-minute render is dispatched, how the athlete profile is shaped, how the interview is guaranteed to finish, how a duration miss is handled, how Apple tokens get revoked. A coding agent fills such gaps with guesses.
3. **A few facts changed or were wrong**: US app-store age laws now require Apple's age signals; Supabase Edge Functions' limits and cross-cloud credentials make the split runtime costly; removing reusable narration pushed heavy annual users into negative contribution; the earlier review's claim about Claude model ids was incorrect.

All of this is fixed in the package. The result is five files for Claude Code (CLAUDE.md, SPEC, CONTRACTS, EVALS, DECISIONS) that stand alone.

---

## What was kept as is

Sport scope and engines; adults only, English, iOS only; the full objective-led interview; the eight-block framework and allocations; three contexts and their lengths; three voices and 8–12 tracks; one finished file per session, AAC 96 kbps stereo at −16 LUFS; offline playback; structured debrief; Supabase for Auth, Postgres and Storage; Expo, EAS, RevenueCat, PostHog, Sentry, Vercel; the usage ledger concept; envelope encryption as a requirement; the dark-first visual language and token names; pricing hypotheses; explicit exclusions.

---

## Findings at a glance

| ID | Severity | Area | Finding | Change (where) |
| --- | --- | --- | --- | --- |
| C1 | Critical | Spec structure | "Original remains in force" but the original is not part of the hand-off; design, audio and script rules live only there | Merged into one self-contained spec; originals become non-normative history (SPEC §0, CLAUDE.md) |
| C2 | Critical | Generation and dispatch | Script generation location undefined; render dispatched by an HTTP call nobody can wait for | Whole pipeline in a worker job; outbox + Cloud Tasks + sweeper + leases + checkpoints (D-02, CONTRACTS §8) |
| C3 | Critical | Runtime and credentials | Deno Edge Functions would need Google key files for KMS and Cloud Tasks and would duplicate crypto, schemas and prompts across two runtimes | One TypeScript backend on Cloud Run (`api` + `worker`), no key files (D-01) |
| C4 | Critical | Authorization | Direct client access plus "backend acts as the user" lets the client write the same rows directly, bypassing validation and encryption | API is the only data path; schema not exposed; forced RLS keyed to a per-transaction setting (D-03, SPEC §10.2) |
| C5 | Critical | Contracts | The athlete profile schema, the core contract between intake, summary, generation and validation, was only sketched | Full `athlete_profile_v1` with limits, paths, statuses and generation minimum (CONTRACTS §3) |
| C6 | Critical | Intake | No guaranteed end to the interview; one-turn-at-a-time with no lease expiry can lock a conversation forever | Combined structural + model status, server follow-up counters, Not sure, turn and time caps, turn lease (CONTRACTS §3–§5) |
| C7 | Critical | Compliance | An 18+ checkbox is no longer enough in Texas, Utah and Louisiana | Apple Declared Age Range via `expo-age-range` before account creation (D-06, SPEC §12.5) |
| C8 | Critical | Economics | Without reusable narration, a heavy annual user costs more than they pay; a 12-session trial can cost ~$8 | Costs recomputed, levers made configurable, trial allowance default 3, release gate (SPEC §13, D-17, D-21, D-22) |
| C9 | Critical | Event-day reliability | iOS does not guarantee background downloads; special sessions could find no allowance left | T−72 h generation, held allowance, foreground sync, readiness pushes, bundled backup primer (SPEC §5.2, §6.6, D-14, D-15) |
| H1 | High | Apple sign-in | Supabase's native Apple flow does not store or revoke Apple tokens, so "revoke on deletion" could not be implemented as written | Authorization-code exchange endpoint, encrypted refresh token, revoke step (D-05, SPEC §10.5) |
| H2 | High | Audio timing | ±5 % post-render tolerance with no remedy forces paying TTS twice; the real-time `rehearse` item disappeared from the timeline | Elastic pauses fitted after synthesis, fixed rehearse silences (D-10, CONTRACTS §6) |
| H3 | High | Model contract | The per-turn JSON (union-typed patch values, optional fields, length rules) conflicts with Claude structured-output limits; no safety field | Structured-output-safe schema; constraints in Zod; `safety_signal` added (CONTRACTS §4.2) |
| H4 | High | Intake latency | ~30 turns on a model whose default effort is high makes 8–12 minutes unlikely | p95 ≤ 6 s target, low effort, cached prompt, last 6 turns only, model chosen by eval (SPEC §11.4, D-13) |
| H5 | High | Script quality | "Model-assisted validation" was undefined, yet rules like "no invented facts" cannot be checked deterministically | Judge contract with fixed checks, single shared repair, calibration (CONTRACTS §7, EVALS §4.3) |
| H6 | High | Deletion | A deleted user's JWT stays valid until expiry; restoring a backup resurrects deleted users | Deleted-account check on every request; deletion ledger replayed after restore (SPEC §10.2, §10.4) |
| H7 | High | Allowance | Monthly bucket anchoring, trial grants, conversion and special-session holds were undefined | Exact bucket and availability rules (CONTRACTS §11) |
| H8 | High | Purchases | Applying RevenueCat webhook deltas is fragile under reordering | Webhook = trigger; fetch current customer state and upsert (SPEC §11.2) |
| H9 | High | Accessibility | More token pairs fail contrast than reported, plus input boundaries below 3:1 | Corrected values computed and tested; `borderStrong`, `emberText` added (SPEC §7.2) |
| H10 | High | Auth email | Magic links need universal links and are consumed by link scanners; Supabase's built-in email is not for production | Email one-time code; custom SMTP provider (D-05) |
| H11 | High | Telemetry | Disabling analytics per screen leaks when a new screen is added | Autocapture and replay off globally; typed event allowlist (CONTRACTS §13) |
| H12 | High | Environments | "Separate project or isolated schema" — schema isolation does not isolate auth or storage; region unspecified | Separate projects per environment; co-located region (SPEC §9.4, D-19) |
| H13 | High | TTS | Chunking, provider limits and prosody across items were unspecified | One request per speech item with continuity context; job-scoped chunk cache (SPEC §6.2) |
| M1–M10 | Medium | Various | Streaming ambiguity, Realtime vs polling, reminder design, rate-limit store, duplicate transcript storage, free-tier abuse, file protection, Mac-less testing, missing tables, check-ins mutating the profile | See below |

---

## Critical findings

### C1 — The plan was not self-contained

**Problem.** The annotated plan states that any decision it does not expressly change stays as in the original plan. The colour tokens, typography, components, motion, screen table, script-writing rules (second person, word budget, `rehearse` items), loudness target, encoding format, ducking levels, music styles and voice settings all lived only in the original. Claude Code, given the two annotated files, would either invent these or stop.

**Change.** One merged specification (`docs/SPEC.md`) containing everything needed, with an explicit rule that nothing outside SPEC, CONTRACTS and EVALS is in force. The historical files may be kept in `docs/history/` but are marked non-normative.

### C2 — Script generation and render dispatch

**Problem.** The plan never said where the script is generated. Doing it inside the request means a 30–90 second model call, a possible repair call, and a judge call on the request path, with work lost if the phone disconnects. Separately, "the Edge Function attempts an authenticated HTTP invocation of Cloud Run" for a render that takes minutes: the caller cannot hold the request, and under request-based Cloud Run billing CPU is throttled after a response is sent, so fire-and-forget is unreliable. The scheduled sweep covered a crash between commit and invocation, but not this.

**Change (D-02).** The entire pipeline (generate, validate, judge, repair, synthesize, fit, mix, normalize, upload) runs inside one worker job. Work rows and an outbox row are committed together; the API then enqueues a Cloud Task (OIDC-authenticated, retried with back-off, dispatch deadline up to 30 minutes, concurrency caps that also protect vendor rate limits); a sweeper re-enqueues anything missed. The worker takes a lease, heartbeats and checkpoints the validated script and every synthesized chunk, so a retry never pays twice. `POST /v1/sessions` now returns immediately.

### C3 — Two runtimes and cross-cloud key files

**Problem.** With Supabase Edge Functions (Deno) as the API and a Node worker on Cloud Run, the encryption code, Zod contracts, prompts and safety lexicon must work in both runtimes. Worse, Edge Functions run outside Google Cloud, so calling Cloud KMS (needed for the plan's own encryption design) and Cloud Tasks requires long-lived Google service-account key files stored as Supabase secrets. Edge Functions also cap CPU at 2 s per request and wall-clock time at 150 s on the free plan and 400 s on paid plans.

**Change (D-01).** One Node TypeScript image deployed as two Cloud Run services. Service identities reach KMS and Cloud Tasks with no key files. Supabase stays for Auth, Postgres and Storage. Cost: one warm `api` instance in production to avoid cold starts during the interview.

### C4 — Two data paths created an authorization hole

**Problem.** The plan let the app read "non-sensitive" tables directly through Supabase while sending sensitive operations through server functions. In Supabase, policies for the `authenticated` role apply to the mobile client exactly as they apply to anything else using that role. Any write the server performs "as the user" through those policies, the client can perform directly, skipping validation, encryption and state rules. The plan's own field-ownership matrix was hard to enforce under that model.

**Change (D-03).** Tables live in an `app` schema that is not exposed through the Data API, with no privileges for `anon` or `authenticated`. The app uses Supabase only for sign-in. The backend connects with dedicated roles that cannot bypass RLS; forced RLS policies key on a per-transaction `app.user_id`, so a query that forgets its ownership filter still cannot read another athlete's rows. One boundary, testable with two-user integration tests and pgTAP.

### C5 — The athlete profile contract was missing

**Problem.** The profile connects the interview, the summary card, script generation, validation ("skipped content never appears"), debrief learnings and export. The annotated plan showed only the new `objective` object. Without the full shape, field limits, list item identity (needed for corrections), statuses and a generation minimum, each part would be built against a different guess.

**Change.** `athlete_profile_v1` in CONTRACTS §3: every field with length and count limits, stable item ids, provenance, the closed list of model-writable paths, sensitive (skippable) paths, the status rules, and the minimum required before a session can be generated.

### C6 — The interview could fail to finish, or lock up

**Problem.** Completion required counts ("at least 3 visual details") and said the server decides status deterministically, but a deterministic rule cannot judge whether "it's loud" is specific enough. Skip was only allowed on sensitive questions, and there was no turn or time cap, so an athlete with weak visual imagery could be interrogated indefinitely. Separately, "only one turn may be processing" had no lease expiry: a crashed request would leave the conversation permanently locked.

**Change.** Status is the lower of a structural rule and the model's quality assessment (the model can lower, never raise). The server counts follow-ups per field and stops at two. Not sure is allowed on every non-sensitive field. Caps at 40 athlete turns or 15 active minutes move the athlete to the summary, where any missing minimum field becomes an inline Add row. Turns hold a 60-second lease that a retry can take over.

### C7 — Age assurance

**Problem.** The plan relied on an 18+ self-confirmation. Texas's App Store Accountability Act has been enforced for new Apple accounts since June 2026 after an appeals court stayed the injunction, Utah's law took effect in May 2026 and Louisiana's in July 2026, and Apple directs developers to its Declared Age Range API for these obligations.

**Change (D-06).** Before account creation the app requests the age range with a minimum of 18 (`expo-age-range`, a first-party Expo module). Under 18 is blocked; declined or unavailable falls back to self-attestation only where Apple signals no regulatory requirement. Counsel confirms per storefront. This drives the minimum iOS default of 26.0 (D-18), since the API needs iOS 26 and Xcode 26 builds anyway.

### C8 — Annual and trial economics

**Problem.** The original cost estimate assumed about 40 % of each session came from reusable pre-rendered narration. The annotated plan correctly removed reuse but kept the session cap and prices. At ElevenLabs' current API price ($0.10 per 1,000 characters for Multilingual), a 15-minute session's speech alone costs about $0.54, and the full variable cost is about $0.62–0.68. An annual subscriber nets about $5.67 a month after Apple's 15 % commission, so one who uses all 12 sessions this way costs about $7.40–8.20. The 7-day annual trial included the full allowance, so a trialist who never converts could cost about $8.

**Change.** SPEC §13 recomputes costs per session type, makes TTS model per context, trial allowance, monthly allowance and caps configurable, sets the trial default to 3 sessions (topped up on conversion), and turns economics into a release gate with explicit levers for the founder (D-17, D-21, D-22). This is flagged, not decided: the pricing itself is a business call.

### C9 — Event-day reliability

**Problem.** "Downloaded at least 24 hours before the event" assumed background downloads. iOS does not guarantee them; the app often has to be opened. Also, special sessions consumed allowance when generated, so a Pro athlete who used all 12 sessions earlier in the month would have no primer for race day.

**Change.** Special sessions generate at T−72 h; their allowance is held (on-demand allowance excludes them; free primers are reserved at program creation). The app syncs offline content on every foreground, notification open and opportunistic background run, and reports verified downloads; the server sends nudges at T−48 h and T−24 h if not verified. A reviewed, clearly labelled non-personalized 3-minute primer per voice ships in the app as a last resort (D-14). This is the one small addition to scope in this review; it protects the product's most important moment and costs about 6 MB.

---

## High findings

**H1 — Sign in with Apple token revocation.** Supabase's native Apple sign-in issues a Supabase session but does not keep Apple's refresh token or call Apple's revoke endpoint. The app must send Apple's authorization code to the backend right after sign-in (it is short-lived and single-use); the backend exchanges it, stores the refresh token encrypted, and revokes it during deletion. Added as an endpoint and a deletion step.

**H2 — Duration handling and real-time rehearsal.** The plan required ±5 % after rendering but defined no remedy, which in practice means re-synthesizing and paying again. Since the timeline contains explicit silences, the renderer now scales ordinary pauses within bounds after synthesis to hit the target. The original plan's `rehearse` item (silence sized to the real duration of an action, the core of real-time PETTLEP rehearsal) had been dropped from the annotated schema; it is restored and never stretched.

**H3 — Model output schema versus structured-output limits.** Claude structured outputs do not enforce string lengths or numeric ranges, cap optional parameters at 24 and union-typed parameters at 16 across a request, and require `additionalProperties: false`. The annotated plan's JSON Patch with a free-typed `value` would need unions and optional fields. The new contract makes every property required, uses a string `value` (JSON-encoded for structured items), and moves limits into Zod. It also adds the `safety_signal` field that the model-as-second-layer design needed but the contract lacked.

**H4 — Intake latency.** Claude Sonnet 5.5 defaults to high effort with adaptive thinking. Across 25–40 turns, multi-second waits consume much of an 8–12 minute interview. The spec sets a p95 server-time target of 6 s, low effort for intake turns, prompt caching, and only the draft profile plus the last six turns as context; moving intake to Haiku 5.5 is allowed if the intake evals pass.

**H5 — Model-assisted validation.** Checks such as "no invented people, injuries or results" or "no unsupported technique" cannot be done with regexes. A judge call with a fixed list of checks, one shared repair attempt, failure counts per check, and calibration against human review before the judge is trusted (EVALS §4.3).

**H6 — Deleted users and backups.** Access tokens stay valid until they expire, so the API checks `deleted_at` on every request. Supabase backups cannot be edited selectively, so a minimal deletion ledger (user id and time) is replayed after any restore, and backup expiry is disclosed.

**H7 — Allowance details.** Buckets are anchored to the original purchase time, with month-end clamping; the trial is its own bucket; conversion tops up; no rollover; lapses stop grants immediately; special sessions are held. Availability is one formula.

**H8 — RevenueCat ordering.** Webhooks can arrive late, twice or out of order. The webhook now only stores the event and enqueues a sync that fetches the current customer state from RevenueCat and upserts a snapshot. RevenueCat's app user id is the Supabase user id; Purchases is configured only after sign-in.

**H9 — Contrast.** I recomputed every pair with the WCAG formula. Beyond the pairs listed in the critical review, the light theme's `accent` (4.09:1 on `bg`), `success` (3.19:1), `danger` (4.12:1) and `ember` (2.45:1) also fail as text, and white on the light accent is 4.34:1. Inputs and chips had no boundary at 3:1. Corrected values keep each hue and only change lightness; `ember` stays decorative with a new `emberText` for text; a new `borderStrong` gives inputs and chips a compliant outline. A CI test enforces all of it.

| Token (theme) | Was | Now | Worst-case contrast now |
| --- | --- | --- | --- |
| textTertiary (dark) | #6B7590 | #818AA2 | 4.61:1 on surfaceRaised |
| textTertiary (light) | #8A93A8 | #636D85 | 4.62:1 |
| accent (light) | #4E6EF2 | #3B5EF1 | 4.62:1; white on it 5.18:1 |
| success (light) | #1F9E74 | #187C5B | 4.60:1 |
| warning (light) | #B7861F | #8C6718 | 4.61:1 |
| danger (light) | #D64545 | #CE2D2D | 4.64:1 |
| emberText (light, new) | — | #A85714 | 4.64:1 |
| borderStrong (new) | — | #566C9E dark / #788AB4 light | ≥ 3.06:1 non-text |

**H10 — Email sign-in.** Magic links need universal-link configuration and are frequently consumed by corporate email link scanners before the athlete taps them. A 6-digit email code avoids both. Supabase's built-in email sender is rate-limited and not meant for production, so a transactional email provider is configured as custom SMTP (added to founder actions).

**H11 — Telemetry.** "Disable autocapture and replay on sensitive screens" fails silently when someone adds a screen. Both are off globally; events go through a typed allowlist with bounded properties; the analytics id is not the auth id.

**H12 — Environments and region.** Schema-level isolation does not isolate Auth users, Storage or secrets, so environments are separate projects. Supabase and Cloud Run are co-located (default Montréal, D-19) to keep interview latency low.

**H13 — TTS chunking.** One request per speech item (≤ 600 characters, far below provider per-request limits), with neighbouring text passed as continuity context where the provider supports it, parallelism capped, and a content-hash chunk cache scoped to the job.

---

## Medium findings

- **M1 Streaming.** "May be streamed" left the choice to the agent. v1 returns the committed turn and the client reveals it (D-07).
- **M2 Realtime.** Not needed once the API is the only data path; polling plus push (D-08).
- **M3 Reminders.** Hourly server scans for 7 pm reminders duplicate or miss across time zones. Reminders are local notifications in the event's time zone; server push is reserved for "ready" and readiness nudges, each sent once (D-09).
- **M4 Rate limiting.** Multi-instance backends need a shared store; Postgres token buckets (D-16).
- **M5 Transcript duplication.** The transcript is derived from the encrypted script instead of stored twice (D-11).
- **M6 Free-tier abuse.** Each new account costs about $1 in model and voice usage. DeviceCheck limits free generated sessions to one account per device without collecting identifiers (D-26).
- **M7 File protection.** Using the strictest iOS file protection would stop a downloaded session playing on a locked phone. Files use the default "until first unlock" class, live in Documents, and are excluded from iCloud backup.
- **M8 Mac-less development.** The founder has no Mac and no simulator. Every milestone now ends with a written device checklist; CLAUDE.md tells the agent it cannot observe the app.
- **M9 Missing tables.** Devices, Apple tokens, exports, deletion jobs, the deletion ledger, notification deliveries, safety events, session downloads and rate-limit buckets were implied but not listed.
- **M10 Check-ins.** Letting check-ins alter the profile added a second learning path. Check-ins now inform the next generation as context; only confirmed debrief items change the profile.

---

## Corrections to the earlier critical review

- **Model ids.** It stated that `claude-sonnet-5-5` and `claude-haiku-5-5` do not appear in Anthropic's active model list. Anthropic's models overview lists both as current API ids (Claude Sonnet 5.5 and Claude Haiku 5.5). They are kept as defaults, still supplied through configuration.
- **Contrast.** It listed six failing pairs; the light theme has five more failing text colours (above).
- **Scope narrowing.** It recommended launching with runners only. The founder chose a broader, bounded set of engines; this review does not reopen that, and instead requires per-engine evals and human review before a sport is called launch-ready.

---

## Deliberately not changed

- **Sport list and full interview length.** Product decisions; the technical risks are handled with caps, evals and per-engine readiness gates.
- **Supabase as Auth, Postgres and Storage.** Fine once the data path is single.
- **Pricing.** Only flagged with numbers and levers; the founder decides.
- **AAC 96 kbps stereo.** Mono would halve file size, but the music bed benefits from stereo and the size is acceptable.
- **Envelope encryption.** Kept and made concrete rather than replaced with platform encryption; it became cheap once key files were no longer needed.
- **Light theme.** Kept; only failing values changed.

---

## Founder decisions that matter most now

From `docs/DECISIONS.md` (open items have working defaults so building can start):

1. **D-25 legal entity and Apple account type**, because it determines the App Store record, bundle id and production setup.
2. **D-19 region** before the backend is provisioned (default Montréal).
3. **D-17 and D-22 economics** before public launch (default trial allowance 3).
4. **D-30 content and safety reviewer**, needed for the red-team set and the backup primer before beta.
5. **D-27 voices and music licences**, needed before beta.

---

## Using the package with Claude Code

1. Create an empty repository. Copy `CLAUDE.md` to its root and the `docs/` folder alongside it.
2. Optionally put the original Envision plan, the annotated plan and the critical review in `docs/history/`. CLAUDE.md already tells the agent they are not requirements.
3. Start with this prompt:

   > Read CLAUDE.md, then docs/SPEC.md, docs/CONTRACTS.md, docs/EVALS.md and docs/DECISIONS.md in full. List anything that is unclear or contradictory before writing code. Then plan and start Milestone 1 (SPEC §15). Do not begin Milestone 2 until I confirm the M1 spike results and decisions D-19 and D-21.

4. Milestone 1 can start immediately with test vendor keys. Production configuration waits for D-25.

---

## Sources checked for this review (2026-10-11)

- Supabase Edge Functions limits: https://supabase.com/docs/guides/functions/limits
- Supabase JWTs and JWKS verification: https://supabase.com/docs/guides/auth/jwts
- Google Cloud Tasks HTTP targets (OIDC, 30-minute handler maximum, task naming): https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks
- Anthropic models overview (current ids and prices): https://platform.claude.com/docs/en/models/overview
- Anthropic structured outputs (parameters and schema limits): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- ElevenLabs API pricing (summarized by third parties, consistent with the vendor page): https://elevenlabs.io/pricing/api
- Expo Audio (background playback, lock-screen controls): https://docs.expo.dev/versions/latest/sdk/audio/
- Expo AgeRange (Declared Age Range): https://docs.expo.dev/versions/latest/sdk/age-range
- Texas SB 2420 enforcement for new Apple accounts (June 2026): https://9to5mac.com/?p=1054393
- Apple age requirements for Utah and Louisiana (2026): https://techcrunch.com/2026/02/24/apple-rolls-out-age-verification-tools-worldwide-to-comply-with-growing-web-of-child-safety-laws/
- Sign in with Apple token revocation with Supabase native auth: https://makerkit.dev/docs/react-native-supabase/config-requirements and Apple Developer Forums guidance on account deletion and token revocation
