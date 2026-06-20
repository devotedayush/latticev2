# Lattice V2 — Engineering Specification

> Goal: a single source of truth precise enough that an engineer who has never seen Lattice can
> build V2 — schema, server, client, AI — and understand *why the core differs from V1*.
>
> Companion: [`PRD.md`](PRD.md) (the *why* and *what*). Predecessor reference: V1 at
> `../lattice/lattice` (its `docs/SPEC.md` is the authority for everything V2 **ports** verbatim —
> persona, prompts, RLS shapes, the seven primitives). This document specifies what V2 **changes**.

---

## 0. One-paragraph mental model

Lattice V2 is an **event-sourced, AI-native team execution memory**. A user speaks or types a
natural-language update. The server interprets it with an LLM into a set of **append-only, reversible
events** — each attributed to the author and linked to the raw utterance. Current state (the seven
primitives, the goal, assumptions, interventions) is a **fold over events into a maintained snapshot**.
The same chat surface answers questions from the snapshot. Nudges, the Morning Brief, and delivery
stats are pure functions over the snapshot, **cached**. Reads go through a single
`deriveView(snapshot, viewer, lens)` function — the teammate, lead, and founder views are the same
query with a different `viewer`/`lens`. Writes are **optimistic** on the client and reconcile to
server truth, with an always-visible per-utterance **undo/correct** affordance. Everything is
multi-tenant (teams) with Supabase Auth + RLS, where **reads are symmetric within a team and mutation
is role/owner-gated**. No cron, no background worker.

**The V1→V2 inversion in one line:** V1 stored the LLM's *conclusions* as truth and logged changes
secondarily. V2 stores *events* as truth and derives conclusions. The snapshot table looks a lot like
V1's `field_objects`, so most ported code survives — but it is now a cache, not the source.

---

## 1. Stack & runtime

Ported from V1 unless noted. Versions track V1's `SPEC.md §1`.

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router), Turbopack dev | Route Handlers under `app/api/v2/*`. **Client is split into modules, not one 4400-line page** (see §7). |
| UI | React 19 | Mostly `"use client"`; no design-system dep. |
| Language | TypeScript (strict) | `npx tsc --noEmit` is the canonical check. |
| Styling | Tailwind v4 PostCSS + hand-written `globals.css` | Ported palette + classes. |
| DB / Auth / Realtime | Supabase (Postgres 15) | RLS on every table. **Realtime patches entities, not full re-pull** (§5). |
| AI — text | OpenAI Chat Completions | Default `gpt-5.4-mini` (`OPENAI_MODEL`). JSON response-format where shape matters. |
| AI — audio | OpenAI transcription | `gpt-4o-mini-transcribe` default. |
| Email | nodemailer (SMTP) | Optional; invites/digests. |
| Validation | zod | **Used seriously in V2** to validate the interpret JSON envelope before it becomes events. |
| Deploy | Vercel | — |

**Module alias:** `@/...` → repo root.

### Request lifecycle (V2)

```
Browser (modular client)
  → optimistic apply: render the change immediately from a provisional event
  → authedFetch() attaches Authorization: Bearer <supabase access_token>
  → /api/v2/... Route Handler
      → requireUserSupabaseClient(request): validates JWT, returns a user-scoped client (RLS as them)
      → interpret/mutate → append events (truth) → fold into snapshot (cache) → return { events, snapshot, team }
  ← client reconciles optimistic state with returned truth; shows "Recorded … — fix?" affordance
  ← Realtime: other clients receive the new event(s) and PATCH the changed entity into local state
```

---

## 2. Environment variables

Identical to V1 (`SPEC.md §2`): `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TRANSCRIBE_MODEL`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, SMTP_*,
`APP_BASE_URL`. Same graceful-degradation behavior (no OpenAI key → deterministic parsers; only
`/api/transcribe` hard-fails). Env changes require a server restart.

**New (optional):** `BRIEF_CACHE_TTL_SECONDS` (default 900) — TTL for the cached LLM-polished brief.

---

## 3. Data model — the re-foundation

All tables in schema `public`; **RLS enabled on every table**. The enums, the membership/teams
tables, invites, join-requests, and platform-feedback are **ported from V1 unchanged** (V1 `SPEC.md
§3.1–3.2`). What follows is what V2 **adds or changes**.

> **Lesson carried from V1's drift warning:** every column the app uses MUST exist as a committed
> migration. V2 has no "applied via MCP without a migration" columns. `supabase/migrations/` is the
> authority and must reproduce the live DB exactly.

### 3.1 New enums

```sql
-- event kinds: a superset of V1's lattice_change_kind, used as the TRUTH stream
create type lattice_event_kind as enum (
  'entity_created','entity_updated','owner_change','due_change','confidence_change',
  'status_change','blocker_emerged','blocker_resolved','goal_shift','scope_change',
  'assumption_changed','intervention_suggested','deferral','decline','retraction','note'
);

create type lattice_utterance_source as enum ('chat','voice','manual','seed','system');
```

V1's `lattice_change_kind`, `orgmind_object_type`, `lattice_goal_state`, etc. are still created (the
snapshot/derived tables reuse them). Create each idempotently
(`do $$ begin create type ...; exception when duplicate_object then null; end $$;`).

### 3.2 New core tables (the truth layer)

**`utterances`** — the raw thing a human said. *(New.)*
- `id text PK`, `team_space_id → team_spaces CASCADE`, `actor_user_id uuid → auth.users SET NULL`,
  `actor_name text` (denormalized display name at time of utterance),
  `raw_text text not null`, `source lattice_utterance_source not null default 'chat'`,
  `audio_ref text`, `interpretation jsonb` (the validated interpret envelope, for replay/debug),
  `created_at timestamptz not null default now()`.
- Index `(team_space_id, created_at desc)`.

**`events`** — append-only, reversible source of truth. *(New — this is the heart of V2.)*
- `id text PK` (`evt-<ts>-<rand>`), `team_space_id → team_spaces CASCADE`,
  `seq bigint not null` (monotonic per team; see §3.5 sequence),
  `utterance_id text → utterances(id) ON DELETE SET NULL` (null for system/manual),
  `actor_user_id uuid → auth.users SET NULL`, `actor_name text`,
  `kind lattice_event_kind not null`,
  `entity_id text` (the logical primitive/goal/assumption this concerns; null for pure notes),
  `entity_type orgmind_object_type` (or a small enum extension for goal/assumption),
  `before jsonb`, `after jsonb` (the field-level delta — enables exact reversal and conflict checks),
  `confidence numeric CHECK (confidence is null or (confidence >= 0 and confidence <= 1))`,
  `supersedes text → events(id) ON DELETE SET NULL` (the event this corrects/replaces),
  `retracted_at timestamptz`, `retracted_by uuid → auth.users SET NULL`,
  `source text not null default 'interpretation'` (`interpretation|manual|seed|system`),
  `created_at timestamptz not null default now()`.
- Indexes: `(team_space_id, seq)`, `(entity_id, seq)`, `(team_space_id, created_at desc)`.
- **Append-only RLS:** SELECT + INSERT gated by `M(team_space_id)`; **no UPDATE except setting
  `retracted_at`/`retracted_by`** (a retraction is itself preferably a new `retraction` event, but an
  in-place retract flag is allowed for simplicity — pick one and keep it consistent; this spec uses a
  new `kind='retraction'` event that points via `supersedes`, and the fold treats the target as
  retracted). No DELETE.

**`entities`** — the derived snapshot of the seven primitives. *(Replaces V1 `field_objects` as a
**cache**; same shape so ported UI/code applies.)*
- All of V1 `field_objects`' columns: `id, team_space_id, type, title, detail, owner, status,
  confidence, pulse, links, due_at, deferred_until, decline_reason, created_at, updated_at`.
  (Legacy `position_x/position_y` are **dropped** — the canvas is gone.)
- **New:** `last_event_seq bigint not null default 0` (high-water mark of the fold),
  `conflict jsonb` (null, or `{ field, claims: [{actor, value, event_id, at}] }` when two recent
  un-retracted events from different actors disagree on a field),
  `unowned boolean generated always as (owner is null or owner = '') stored`.
- This table is **always reconstructible** by re-folding `events`. Treat it as disposable cache.

**`goals`, `assumptions`, `interventions`** — kept as in V1, but also **derived from events** (their
transitions are recorded as events; the rows are the snapshot). `confidence_signals` is **subsumed by
`events`** of `kind='confidence_change'` (the sparkline reads those); keep the table only if a ported
query depends on it, otherwise drop.

**`view_cache`** — derived-view cache. *(New, optional but recommended.)*
- `team_space_id text`, `key text` (`brief|nudges|stats:<member>`), `payload jsonb`,
  `computed_at timestamptz`, `valid_until timestamptz`, PK `(team_space_id, key)`.
- Invalidated on any event insert for the team (cheap: delete rows for that team, or compare
  `last_event_seq`).

### 3.3 Ported tables (unchanged from V1)

`team_spaces`, `team_members` (with `skills/focus/bio/role`), `memory_events`, `delegated_requests`,
`reminders`, `interpretations` (now largely redundant with `utterances` — keep for back-compat or
drop), `team_invitations`, `team_join_requests`, `platform_feedback`, `dependencies`. See V1
`SPEC.md §3.2` for exact columns. **All columns the app uses must be in a migration.**

### 3.4 Functions, triggers, RLS

- Port V1's `set_updated_at`, `is_orgmind_team_member` (`M`), `is_lattice_team_admin` (`A`),
  `is_platform_admin`, and the new-user handling (`handle_new_orgmind_user` created then its trigger
  dropped → new users go through the first-team gate). V1 `SPEC.md §3.3`.
- **RLS change — symmetry (PRD Principle 5):** member-scoped tables are SELECT-gated by `M(team)` for
  **all** members (already true in V1). The V2 invariant is: **no table grants a member visibility the
  rest of the team lacks.** Mutation stays gated: `entities`/`events` insert by `M`; destructive
  entity actions owner/admin-gated at the app layer (§4.3); `team_members` UPDATE/DELETE by `A`.
- **`events` is append-only** (SELECT+INSERT by `M`; retraction via insert, not update/delete).
- **`view_cache`** SELECT/INSERT/UPDATE/DELETE by `M(team_space_id)` (it's just memoized reads).

### 3.5 Sequence & ordering

- Per-team monotonic `seq` via a Postgres sequence or `select coalesce(max(seq),0)+1 from events
  where team_space_id = $1 for update` inside the insert transaction. `seq` gives a total order for
  the fold and a high-water mark (`entities.last_event_seq`) so realtime patches can detect gaps and
  fall back to a scoped re-fold if needed.

### 3.6 Realtime publication

Add to `supabase_realtime`: **`events`** (primary), plus `entities`, `goals`, `assumptions`,
`interventions`, `team_members`, `team_invitations`. Clients subscribe primarily to `events` and
patch (§5).

---

## 4. The write path — interpret → events → snapshot (the core flow)

### 4.1 Interpretation (ported AI, new output target)

Port V1's `interpretV2(input, state, members)` (V1 `SPEC.md §8`) **verbatim for prompt + persona +
owner/due rules**. The only change: its JSON envelope is **validated with zod**, then **translated
into events** rather than written directly as rows.

```
POST /api/v2/interpret  { input, apply?, teamId }
  1. resolve team; load snapshot + members
  2. interpretV2(input, snapshot, members) → envelope { reply, richReply, entities[], changes[],
       goalShift?, assumptions?[], interventions?[], confidenceImpact?, followUpQuestion? }
  3. zod-validate envelope; on invalid → deterministic fallback parser
  4. if !apply → return { interpretation: envelope, snapshot, team }   (preview; no writes)
  5. if apply (transaction):
       a. insert utterance (raw_text, actor, source, interpretation=envelope)
       b. translate envelope → events[]  (each entity create/update, each change, goal shift,
          assumption, intervention, confidence → an event with before/after, attributed, utterance-linked)
       c. CONFLICT CHECK per event (§4.2) before applying
       d. insert events (assign seq)
       e. fold events onto snapshot (entities/goals/assumptions/interventions) — only the touched ids
       f. invalidate view_cache for the team
       g. return { events, snapshot, team, reply, richReply }
```

**Owner & due rules (ported, non-negotiable):** never default owner to reporter; "I/me/self" leaves
owner empty (offer "assign me" client-side); resolve relative dates to absolute ISO 8601 UTC; never
invent a due date.

### 4.2 Conflict detection (the V1 fix)

When translating an update event that sets field `F` on existing entity `E`:
- Look at the most recent **un-retracted** event that set `F` on `E`.
- If it exists, was authored by a **different** actor, within a **conflict window** (default 48h), and
  the new value differs → do **not** silently overwrite. Apply the new value to the snapshot *but* set
  `entities.conflict = { field: F, claims: [...both...] }` and emit the event with a marker.
- The brief/nudges surface conflicted entities as **needs-decision**. Resolving (any owner/admin, or
  either claimant) clears `conflict` and emits a `status_change`/`due_change` event of record.

### 4.3 Mutations (ported actions, now event-emitting)

Port V1's `PATCH /api/v2/commitment` action table (V1 `SPEC.md §5.2`: complete, resolve, drop,
set_confidence, set_owner, set_due, defer, decline, scope_change) **and its owner-gate** (every action
except `set_confidence` requires caller = current owner OR team admin). The only change: each action
**emits an event** (truth) and then folds onto the snapshot, instead of writing the row + a secondary
change_event. Same for `POST/PATCH /api/v2/goal`, `PATCH /api/v2/intervention`, `PATCH
/api/v2/assumption`.

### 4.4 Undo / correct (new, universal)

```
POST /api/v2/undo   { eventId, teamId }      → emit kind='retraction' supersedes=eventId; re-fold E
POST /api/v2/correct { eventId, patch, teamId } → retraction + a new event with the corrected after; re-fold
```
- Owner-gated like mutations (the author of the utterance OR owner/admin can undo/correct).
- The client's always-visible "Recorded … — fix?" affordance calls these.
- Re-folding an entity = replay its non-retracted events in `seq` order onto a base. Cheap (one
  entity's events). On any gap/uncertainty, re-fold the whole team's snapshot (still bounded at
  prototype scale).

### 4.5 Optimistic apply & reconciliation (client)

- On send, the client constructs **provisional events** from a lightweight local guess (or just shows
  the raw text as "interpreting…") and renders the change immediately.
- On server response, replace provisional state with returned `events`+`snapshot` (truth).
- On **failure**, roll the optimistic change back **visibly** ("couldn't record that — try again"),
  never silently.

---

## 5. Realtime — targeted patch, not full re-pull (the speed fix)

V1 re-pulled the entire `/state` on every DB change. V2:

- Channel `lattice-${teamSpaceId}` subscribes to `events` (and `entities` as a fallback) filtered by
  `team_space_id=eq.<id>`.
- On an `events` insert, the payload carries `entity_id`, `kind`, `after`, `seq`. The client:
  1. flashes the entity (`markUpdated`),
  2. **patches** that entity in local state from `after` (no network),
  3. only if `seq` is **ahead of the local high-water mark by >1** (a gap) does it do a scoped
     `/api/v2/state?team=` re-pull.
- Debounce bursts (e.g. a multi-event interpret) into one render.

This keeps the common case network-free and removes the full re-pull from the hot path.

---

## 6. Performance plan (a first-class concern in V2)

| Concern | V1 | V2 |
|---|---|---|
| Read state | full `/state` fetch + full re-pull on every realtime change | snapshot read; realtime **patches** the changed entity; scoped re-pull only on gap |
| Brief / nudges / stats | pure functions recomputed per read, brief through an LLM | pure functions over the **snapshot**, **cached** in `view_cache` with TTL; LLM polish cached, regenerated on TTL only |
| Writes | await server + LLM before UI updates | **optimistic** apply; LLM off the critical path; reconcile on response |
| Interpret cost/latency | every update → LLM | **deterministic fast path** for unambiguous updates ("done with X", "moving Y to Friday") skips the model; only ambiguous prose hits the LLM; cache identical inputs |
| Fold cost | n/a | fold only the **touched entities** on write; full re-fold only on undo-gap or manual rebuild |

Targets: p95 write-to-visible < 100ms (optimistic); brief served from cache < 50ms; realtime patch
applied without a network round trip.

---

## 7. Client — modular, not one mega-file

V1's entire UI is one ~4400-line `app/page.tsx`. V2 keeps the single-page app feel but **splits by
concern** so the three lenses and the event/undo logic are independently reasonable:

```
app/page.tsx                  — shell, auth gate, team gate, lens router, realtime subscription
components/
  capture/Composer.tsx        — unified chat (ask|tell), voice orb, optimistic send, "fix" affordance
  lenses/MyPlate.tsx          — lens:"mine"
  lenses/TeamView.tsx         — lens:"team"
  lenses/WhatsSlipping.tsx    — lens:"missing" (brief, nudges)
  entities/EntityRow.tsx      — one primitive row + actions (de-jargoned labels)
  entities/ConflictBanner.tsx — "two claims" surface
  history/EventFeed.tsx       — attributed, retractable event history
  team/ManageTeam.tsx, MyProfile.tsx, FirstTeamGate.tsx, onboarding/ColdStart.tsx
lib/
  view.ts                     — deriveView(snapshot, viewer, lens)  (§8)
  fold.ts                     — fold(events) → snapshot; refoldEntity(events, id)
  events.ts                   — envelope → events[] translation, conflict check
  ...ported lib/* (persona, ai-v2, nudges, member-stats, teams, supabase, auth-server)
```

De-jargon (PRD §7) lives in `EntityRow` label maps and the empty/onboarding copy. No primitive
type-name renders to the user.

---

## 8. The symmetric read layer — `deriveView`

One function powers all three lenses. Lenses are filters over one truth.

```ts
type Viewer = { userId: string; memberName: string; role: 'owner'|'admin'|'member' };
type Lens = 'mine' | 'team' | 'missing';

function deriveView(snapshot: LatticeSnapshot, viewer: Viewer, lens: Lens): ViewModel
```

- **`mine`** — entities owned by `viewer.memberName` (case-insensitive, the V1 name-match rule) +
  requests targeting them; an honest **load** summary (open count, due-soon count); **owed-to-me**
  (requests the viewer made + blockers others own that gate the viewer's items via `links`); per-item
  pushback affordances.
- **`team`** — all entities grouped by type; blockers; `goalDrift`; `structuralAnalysis` (overloaded
  owners ≥2 blockers, recurring blocker tokens). **Visible to every member** (symmetry).
- **`missing`** — `buildBrief` (changed/at-risk/needs-decision, incl. conflicted entities) + top
  interventions + `deriveNudges`. Cached.

**Visibility rule:** any `viewer` may request any `lens` for any member. The function never hides data
based on role. Role only affects which **action buttons** render (mutation), enforced again server-side.

Port the V1 derived-logic formulas verbatim (V1 `SPEC.md §7`): `teamConfidence`, `atRiskCount`,
`goalDrift`, `structuralAnalysis`, `deriveNudges` (thresholds: stale 72h, blocker 24h, assumption
7d), `statsForMember`. They now read the snapshot; nothing else changes.

---

## 9. Server — API surface (deltas from V1)

Ported routes keep V1's contracts (V1 `SPEC.md §5`). The deltas:

- **`POST /api/v2/interpret`** — now returns `{ events, snapshot, team, reply, richReply }`; writes via
  the event path (§4). Preview mode (`apply:false`) returns the envelope, no writes.
- **`POST /api/v2/undo`**, **`POST /api/v2/correct`** — **new** (§4.4).
- **`PATCH /api/v2/commitment`** and the other mutations — same actions, same owner-gate, now
  event-emitting (§4.3).
- **`GET /api/v2/state?team=`** — returns the **snapshot** (`entities`, goal, assumptions,
  interventions, recent events). Still 200 `{ state:null, teams:[] }` for no-team users.
- **`GET /api/v2/view?team=&lens=`** — **new, optional**: server-side `deriveView` for the viewer
  (or compute client-side from the snapshot; either is fine — the snapshot is small).
- **`GET /api/v2/nudges`**, **`POST /api/v2/brief`** — same logic, now served from `view_cache`.
- **`GET /api/v2/events?team=&entity=`** — **new**: the attributed history feed for an entity or team.
- Teams/members/invites/join/digest/admin/feedback/transcribe routes — **ported unchanged** (V1
  `SPEC.md §5.3–5.4`), including the explicit admin gates and service-role usage for un-membered flows.

All `/api/v2/*` require `requireUserSupabaseClient` (401/503) unless public (join-links, invite
accept) — ported.

---

## 10. AI layer (ported)

- **`lib/persona.ts`** — `LATTICE_PERSONA` + `APP_KNOWLEDGE` ported **verbatim** (the voice must not
  drift). One adjustment: `APP_KNOWLEDGE`'s self-description answers in **user language** (promises,
  blockers, what's owed) and only explains primitive names if explicitly asked.
- **`lib/ai-v2.ts`** — `interpretV2` ported; output now zod-validated and translated to events.
- **`lib/ai.ts` / fallback** — ported deterministic parser for the no-key path; it emits events too.
- New answering rule for `/api/v2/ask`: when state holds **conflicting claims**, surface both rather
  than pick one ("Ada says Friday, Sam says Monday — unresolved").

---

## 11. Build order (single maintainer)

1. **Supabase project.** Port V1's enums/tables/functions/RLS (V1 `SPEC.md §9.1`), **as committed
   migrations** (no drift). Then add the V2 layer: `lattice_event_kind`/`lattice_utterance_source`
   enums, `utterances`, `events` (append-only RLS, per-team `seq`), `entities` snapshot (V1
   `field_objects` minus coords, plus `last_event_seq`/`conflict`/`unowned`), `view_cache`. Add
   `events`+`entities` to realtime. Drop the canvas coords and the new-user auto-join trigger.
2. **`lib/fold.ts` + `lib/events.ts`.** The fold and the envelope→events translation with conflict
   check. Unit-test: a sequence of events folds to the expected snapshot; a retraction reverses;
   conflicting events flag, don't overwrite.
3. **Port AI + derived logic.** `persona.ts`, `ai-v2.ts`, `nudges.ts`, `member-stats.ts`, `v2.ts`
   formulas. Add zod validation of the interpret envelope.
4. **Write path.** `/api/v2/interpret` (event-emitting), `/undo`, `/correct`, the mutation routes
   (ported owner-gate). Prove end-to-end: "Priya is blocked on auth, demo's Friday" → utterance +
   events → snapshot has a blocker (owner Priya) + a Friday-due commitment → undo reverses it.
5. **Read layer.** `lib/view.ts` `deriveView` + the three lenses; `view_cache`; `/api/v2/state`,
   `/view`, `/events`, cached `/nudges` + `/brief`.
6. **Client.** Modular split (§7): shell + lens router, Composer with optimistic send + "fix"
   affordance, the three lens components, EntityRow (de-jargoned), ConflictBanner, EventFeed,
   ColdStart onboarding. Realtime **patching** subscription (§5).
7. **Teams/membership/admin** — port V1 wholesale.
8. **Verify:** `npx tsc --noEmit`, `npx eslint app lib`, `npm run dev`. Walk every PRD §5 journey,
   especially **5.6 conflicting updates** and the **optimistic+undo** path. Confirm a teammate
   (non-admin) can see the Team lens (symmetry) but cannot mutate others' items (gate).

---

## 12. Invariants to preserve (V2)

- **Events are truth; the snapshot is cache.** The snapshot must always be reconstructible by folding
  events. Never write the snapshot without a corresponding event.
- **Every write is attributed, utterance-linked, and reversible.** No silent state changes.
- **Visibility is symmetric within a team; mutation is role/owner-gated.** Enforced in RLS (reads) and
  app layer (destructive actions) — never a one-way mirror.
- **Conflicts are surfaced, never silently resolved.** Two claims, flagged, until someone decides.
- **Confidence is owner-set belief-it-lands, not a % done and not an AI verdict on a person.**
- **Never default owner to the reporter; "I/me/self" is unowned.** Offer "assign me," don't assume.
- **Optimistic writes reconcile to server truth; failures roll back visibly.**
- **Derived views are pure functions over the snapshot, cached — never recomputed over the whole graph
  or through an LLM on the hot path.**
- **No primitive type-name surfaces to a user** (de-jargon is a requirement, not polish).
- **One persona voice everywhere**, ported verbatim.
- **Migrations reproduce the live DB exactly** — V1's drift does not recur.
