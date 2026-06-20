# Lattice V2

An AI-native, **event-sourced** team execution memory. Tell it what's happening in plain
language; it tracks who owes what and flags what's slipping — for the whole team, not just the
boss.

V2 is a **re-foundation** of V1, not a rewrite. It ports V1's working assets (persona, interpret
prompts, RLS, the seven-primitive ontology) and rebuilds the data core around an append-only,
reversible event log with a symmetric read layer.

> Design docs: [`docs/PRD.md`](docs/PRD.md) (the *why/what*) · [`docs/SPEC.md`](docs/SPEC.md)
> (the *how*). Read those first.

## The two ideas everything hangs on

1. **Store the utterance, derive the state.** Truth = `utterances` + append-only, reversible
   `events`. Current state is a fold over events into an `entities` snapshot (a disposable cache).
   This makes undo universal, misinterpretation correctable, conflicting updates first-class
   ("two claims," not last-write-wins), and history fully attributable.
2. **One graph, one query, parameterized by viewer.** Teammate / lead / founder are *postures*,
   not separate dashboards — `deriveView(snapshot, viewer, lens)` with lenses `mine | team |
   missing`. Visibility is symmetric within a team; roles gate mutation only. That's what keeps it
   from feeling like surveillance.

## Status

- **DB event core: live** (Supabase project `rwmovpttwmmitblisxeu`). Migrations:
  `v2_event_core_schema`, `v2_event_core_fold`. Tables: `utterances`, `events` (append-only,
  per-team monotonic `seq`), `entities` (derived snapshot), `view_cache`. A Postgres
  `lattice_fold_entity` + auto-fold trigger maintains the snapshot and detects conflicts on
  due/status/owner. Verified end-to-end: capture → snapshot, undo, conflict surface+resolve,
  never-invent-owner, and a full snapshot rebuild from events alone.
- **App: V1 ported + V2 event layer added.** New modules `lib/events.ts` (envelope→events +
  capture/undo/fetch), `lib/fold.ts` (pure TS fold for optimistic client preview), `lib/view.ts`
  (`deriveView` + the three lenses). New routes `POST /api/v2/capture`, `POST /api/v2/undo`,
  `GET /api/v2/entities`.
- **Next:** rewire the client to the event path (optimistic + always-undoable UX), render the
  three lenses, and de-jargon the surface (no primitive type-names shown to users).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind v4 · Supabase (Postgres +
RLS + Realtime + Auth) · OpenAI (Chat Completions + audio transcription).

## Run

```bash
npm install
npm run dev
```

Create `.env.local` (see `.env.example`):

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
NEXT_PUBLIC_SUPABASE_URL=https://rwmovpttwmmitblisxeu.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
APP_BASE_URL=http://localhost:3000
```

Without `OPENAI_API_KEY`, interpretation falls back to a deterministic parser. The event core
itself requires no AI.

## Verify the core

```sql
-- the snapshot is always reconstructible from events alone:
delete from public.entities where team_space_id = '<team>';
-- re-fold every entity:
select public.lattice_fold_entity('<team>', entity_id)
from (select distinct entity_id from public.events where team_space_id='<team>' and entity_id is not null) s;
```
