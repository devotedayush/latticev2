# Lattice V2 — Product Requirements Document (PRD)

> Companion to [`SPEC.md`](SPEC.md) (the engineering *how*). This document is the product
> *why* and *what*. Read this first; read SPEC second.
>
> V2 is a **re-foundation**, not a rewrite. It ports V1's hard-won assets (the persona, the
> interpret/ask/brief prompts, the RLS model, the 7-primitive ontology) and rebuilds the
> **data core** around an append-only, reversible event log with a symmetric read layer.

**Status:** V2 planning. **Last updated:** 2026-06-20. **Owner:** single-maintainer.
**Predecessor:** Lattice V1 (working prototype) at `../lattice/lattice`.

---

## 0. What changed from V1, in one breath

V1 was built almost entirely from the **founder's** seat ("surface what I'm missing") and stored
the LLM's *conclusions* as the source of truth. V2 makes two structural moves that the rest of the
document elaborates:

1. **One person, three postures — not three users.** The teammate, the lead, and the founder are
   the same human pushing state in, pulling state out, and being acted on by others' state. There is
   **one shared graph and one query, parameterized by who's asking.** Visibility is symmetric.
2. **Store the utterance, derive the state.** Every interpretation is a *reversible event*, not a
   row of truth. Current state is a fold over events. This makes misinterpretation correctable,
   conflicting updates first-class, and undo universal.

Everything else V2 does — making the teammate view first-class, de-jargoning the surface, making it
fast — falls out of these two decisions.

---

## 1. Problem (carried from V1, unchanged)

People who run small teams (founders, agency leads, PMs) carry an invisible **memory burden**: who
promised what, who's blocked, what changed direction, which weak signals mean something is off.
Existing tools *store what happened* but don't *understand what's happening* — Linear/Jira are ticket
graveyards, Notion rots, Slack is a firehose. The expensive gap is **what you're missing**: a
commitment that quietly went stale, a blocker nobody owns, execution drifting from stated intent.

**What V1 got wrong about the problem:** it treated this as a *founder-only* memory burden. But a
team tool that only serves the person at the top, by reading everyone else's status, *is*
surveillance — and the people being read have no reason to feed it. The honest restatement: the
memory burden is **shared and asymmetric today**, and the fix is to make the same live model serve
*everyone's* version of "what am I missing," not just the founder's.

## 2. Product vision

**A quiet chief of staff that has been paying attention — and works the same for everyone on the
team.** You tell it what's happening in plain language; it maintains a live, structured model and
tells each person what *they'd* otherwise miss: the teammate sees their real load and what they can
push back on; the lead sees where the team is blocked; the founder sees drift and risk. Same graph,
different vantage.

**One-line pitch (de-jargoned, for users):** *Tell it what's happening; it tracks who owes what and
flags what's slipping — for the whole team, not just the boss.*

**Internal pitch (for us):** AI-native, event-sourced team execution memory with a symmetric read
layer and reversible interpretation.

> **Naming discipline (a hard requirement, see §7):** the words "execution memory," "ontology,"
> "primitive," and the seven type-names (`intent/commitment/blocker/...`) are **internal vocabulary**.
> They never appear on a surface a normal teammate sees. The product explains itself in the language
> of promises, blockers, and what's owed.

## 3. Target users — as postures, not roles

Lattice has **one** kind of user (a person on a small team) who moves between three postures. The
product must feel first-class in each. Roles (`owner/admin/member`) gate **mutation**, never
**visibility**.

| Posture | Who's in it | What they need day-to-day | How V2 serves it |
|---|---|---|---|
| **Teammate / IC** (the wedge) | everyone | "What's actually on my plate, what's owed to me, and what can I push back on without a meeting?" | **My Plate** lens with an honest load count + receipts; one-tap honest pushback; their own track record, theirs to share. |
| **Team lead / PM** | leads | "Where is the team blocked and what's drifting?" | **Team** lens (same graph, mutation rights: reassign, resolve, intervene). Not a thinner founder view — a different lens *with write access*. |
| **Founder** | founders | "What am I missing?" | **What's Slipping** lens: Morning Brief, nudges, goal-drift — now trustworthy because state is attributed and reversible. |

**Why the teammate is the wedge, not an afterthought:** if the IC's view answers a question *they*
have ("am I overcommitted, and here's the receipt"), they want to be on it and they invite their
lead. Bottoms-up beats one-founder-per-company. V1 gave the IC only a "Can't do" button — all take,
no give. V2 inverts that.

Non-goal users (unchanged from V1): large orgs needing sprint planning, time-tracking, or formal
project hierarchy. Lattice stays deliberately small and opinionated — a single maintainer owns it.

## 4. Principles (the non-negotiables)

V2 keeps V1's good principles and adds the structural ones the council surfaced. **Bold** = new or
materially changed in V2.

1. **The ontology is load-bearing — and invisible.** Seven primitives (`intent, commitment, blocker,
   request, reminder, shift, signal`) are the entire internal vocabulary. They drive the schema and
   the prompts. **They never surface as jargon to a user.**
2. **Natural language is the interface.** Voice or text; the system interprets and routes. Users
   never fill a structured form to create a commitment.
3. **One voice everywhere.** A single dry, observant chief-of-staff persona across interpret, ask,
   and brief. (Ported verbatim from V1's `LATTICE_PERSONA`.)
4. **Store the utterance; derive the state.** *(New, load-bearing.)* The source of truth is an
   append-only, **reversible** event log. Current state — entities, nudges, brief, stats — is a pure
   function over events. Conclusions are never stored as un-revisable fact.
5. **Visibility is symmetric; mutation is gated.** *(New, load-bearing.)* Any member can see any lens
   for anyone. Surveillance comes from one-way mirrors, not from being seen — so there are none.
   Roles gate who can *change* things, never who can *see* them.
6. **Every interpretation is reversible and attributed.** *(New.)* Each write carries who said it,
   the raw utterance, and a one-tap "that's not right." Undo is universal, not a special feature.
7. **Confidence is not progress — and not a verdict on a person.** The number is *how likely this
   work is to land by its date*, **set and owned by the work's owner**, not a silent AI score on
   someone. Labeled honestly; never a completion bar.
8. **Never guess ownership.** "I/me/self" is not an assignment. Unowned work stays *visibly* unowned
   until someone is named — and the author gets a one-tap "assign me."
9. **Honest pushback over false certainty.** The assistant says what's missing and surfaces
   conflicts; it never invents state or silently picks a winner between two claims.
10. **Derive on read is for correctness; materialize for speed.** *(New, clarified.)* The derived
    views are *defined* as pure functions, but they are computed against a maintained snapshot and
    cached — never recomputed over the whole graph (or through an LLM) on every read.

## 5. Core user journeys (by posture)

### 5.1 Capture (everyone) — optimistic and undoable
User taps the orb or types: *"Priya's blocked on the vendor API, demo's now Friday."*
- The update **applies instantly** (optimistic): a blocker on the vendor API (owner Priya) and a
  moved due date on the demo appear immediately, with a subtle "interpreting…" state.
- A beat later the server's interpretation reconciles, and an **always-visible "Recorded: blocker on
  vendor API · demo → Fri — fix?"** affordance lets the author retract or correct any part with one
  tap.
- **Acceptance:** a blocker and a dated commitment exist; the history shows `blocker_emerged` +
  `deadline_move`, each attributed to the author and linked to the raw utterance; no owner was
  invented for unstated work; the author can undo either event in one tap.

### 5.2 See my plate (teammate)
IC opens **My Plate** → everything they own, sorted by what's actually due, with an honest load
count ("4 open · 2 due Friday"), what's owed *to* them, and per-item one-tap pushback.
- **Acceptance:** the load count matches their owned, open items; "what's owed to me" lists real
  requests/blockers others own that gate the IC's work; pushing back stores a reason and stops nudges.

### 5.3 Ask a question (everyone, symmetric)
*"Who's overloaded?"* / *"Am I overloaded?"* are the **same function** with a different viewer.
Answered from state, naming people and counts, in persona voice.
- **Acceptance:** answers cite real owners/blockers from the current team; a teammate asking about
  the team gets the same truth a lead would; if state can't answer, it says so rather than inventing.

### 5.4 Morning catch-up (founder/lead)
Open **What's Slipping** → Brief shows ≤3 bullets each of *changed / at-risk / needs-decision*;
Nudges list overdue/stale commitments, unowned blockers, unrevisited assumptions.
- **Acceptance:** every bullet traces to a real event; deferred items don't appear; the brief is
  served from cache, not recomputed per open.

### 5.5 Respond to a nudge (owner)
Owner clicks Reply on "Demo video is 2 days past deadline" → chat pre-filled → "slipped, moving to
Monday" → due date updates. Or "Can't do" → defer / plan-changed / decline + reason → nudges stop.
- **Acceptance:** deferral suppresses future nudges; the reason is stored as an attributed event.

### 5.6 Conflicting updates (the case V1 got wrong)
Ada says "demo's Friday"; an hour later Sam says "demo's Monday." V2 does **not** silently
last-write-wins.
- **Acceptance:** the demo commitment is flagged as having two claims ("Ada: Fri · Sam: Mon"); the
  brief/nudges surface it as *needs-decision*; resolving it is one tap and recorded as an event.

### 5.7 Run the team (admin)
Admin invites members (email or join link), reassigns owners, reviews join requests.
- **Acceptance:** only owners/admins can mutate others' items and membership; **every member can see**
  team load and blockers (symmetry); members can edit their own profile and act on their own items.

## 6. Feature requirements

### 6.1 Capture & interpretation (P0)
- Single chat surface for **ask** and **tell**; intent classified client-side (question vs statement)
  and routed to answer vs interpret. (Ported from V1.)
- Voice capture via mic → transcription → same chat path (handle Safari `audio/mp4`). (Ported.)
- Interpretation produces **events** (not direct row writes): new/changed entities, change events,
  optional goal shift / assumptions / interventions — each reversible, attributed, utterance-linked.
- **Optimistic apply** with reconciliation and an always-visible per-utterance "fix/undo" affordance.
- Owner & due-date extraction rules enforced in the prompt (never default owner to reporter; resolve
  relative dates to absolute UTC; never invent a due date). (Ported.)
- **Conflict detection:** an incoming event that contradicts a recent un-retracted event from a
  different actor flags the entity rather than overwriting.
- Graceful degradation: with no OpenAI key, a deterministic keyword parser still produces reasonable
  events. (Ported.)

### 6.2 Live team model (P0)
- Active **goal** with owner-set confidence and a confidence **sparkline**; goal history via
  supersession chain. (Ported.)
- **Entities** (the seven primitives) as a *derived snapshot* over events: grouped by type, sorted by
  due urgency; per-row actions: Done, Resolve (blockers), Set due, Can't-do (defer/scope-change/
  decline + reason), Drop, reassign owner — **each emits a reversible event.**
- **History** of all events (attributed, utterance-linked, retractable); **Plan vs reality** (drift)
  view; pattern detection (overloaded owners, recurring blocker themes). (Ported; now attributed.)
- **Assumptions** with state (holds/at-risk/invalidated/reconfirmed); invalidated assumptions raise
  risk. (Ported.)
- **Interventions** — AI-suggested next actions with urgency; accept/dismiss/mark-acted. (Ported.)
- **Realtime:** a teammate's change reflects in others' views within ~1s via a **targeted patch** of
  the changed entity (not a full state re-pull), with a brief visual flash.

### 6.3 The three lenses (P0) — one query, parameterized by viewer
- **My Plate** (`lens:"mine"`): owned-by-me + owed-to-me + honest load + pushback affordances.
- **Team** (`lens:"team"`): blockers, drift, overloaded owners — visible to everyone.
- **What's Slipping** (`lens:"missing"`): Morning Brief + Nudges + risk + decisions.
- All lenses available to all members. The same derive function powers all three; lenses are filters
  over one truth, not separate data.

### 6.4 Proactive surfaces (P0, derived & cached)
- **Morning Brief**: changed / at-risk / needs-decision, ≤3 each, optionally LLM-polished, **cached
  with a TTL** (not regenerated per read). (Logic ported from V1; serving changed.)
- **Nudges**: overdue, stale (72h), open blockers (24h), stale assumptions (7d), overdue reminders —
  prioritized; deferred items excluded; Reply + Snooze. (Ported.)
- **Member delivery stats** (the calibration data): shipped count, open/overdue, on-time rate, avg
  time-to-deliver — computed from events. **Captured in V2; surfaced only symmetrically and only as
  much as the council green-lit** (a member's own track record is theirs first). See §9.

### 6.5 Teams, roles, membership (P0)
- Multi-tenant teams; create/switch; first-run gate (create or accept invite). (Ported.)
- Roles owner/admin/member; RLS-enforced for **mutation**. **Reads are symmetric within a team.**
- Self-serve profile (name, skills, focus, bio) editable by the member only. (Ported.)
- Public **invite** (token) and **join** (link → request → approval) flows. (Ported.)
- **Cold-start / onboarding (new):** a new member's day one is designed — a seeded example team or a
  10-second "say your first update," so the empty state isn't a dead end. (See §10.)

### 6.6 Persona & answering (P0)
- Shared `LATTICE_PERSONA` voice; `APP_KNOWLEDGE` lets the assistant explain itself in-voice — but in
  **user language**, not internal jargon. (Ported, surface-language adjusted.)
- Answers ground strictly in state; admit ignorance rather than hallucinate; surface conflicts rather
  than pick a winner. (Ported + extended.)

### 6.7 Explicitly out of scope for V2 (resist the bloat)
- **Push delivery** (Slack/email of nudges/briefs) — still deferred; derive+cache keeps it addable.
- **Passive ingestion** (Slack/standup → events) — high-value wedge, but a multi-week sink for one
  maintainer; deliberately deferred. Capture the design space, don't build it.
- **Surfacing the "delivery trust graph" as a product** — capture the calibration data now; do not
  build cross-team scoring, public reputation, or any one-way scoreboard.
- Tickets, sprints, story points, time tracking, Gantt/Kanban.
- The spatial "Team Field" canvas (stays cut; coords not carried forward).
- Mobile-native apps; SSO/SAML; per-object permissions beyond team roles + symmetry.

## 7. De-jargoning requirements (P0 — a real requirement, not polish)

The council's Outsider was unambiguous: the value is buried under naming that sounds like a database
feature. V2 treats surface language as a requirement:

- **No user ever sees or picks a primitive type name.** The LLM classifies; the UI shows human labels
  ("blocked on," "owes," "heads-up," "due").
- **The landing/empty state explains the job, not the architecture.** A teammate must be able to
  repeat what Lattice does in one sentence without saying "AI," "memory," or any primitive.
- **"Confidence" is reframed** as a forward-looking, owner-set "how likely is this to land by [date]?"
  — never a silent AI judgment on a person. (See Principle 7.)
- **Internal docs keep the precise vocabulary;** SPEC.md is where `commitment`/`promise` etc. live.

## 8. Non-functional requirements

- **Security:** every data path enforced by Postgres RLS; service-role key only server-side for
  un-membered flows (invite accept, join links/requests, admin overview). Bearer-token auth on every
  protected route. (Ported.) **Reads symmetric within a team; mutation gated by role + ownership.**
- **Resilience:** AI is optional; all language features fall back deterministically (except audio
  transcription, which needs a key). **Optimistic writes reconcile to server truth; a failed
  interpretation rolls the optimistic state back visibly, never silently.**
- **Performance (a first-class requirement in V2, see §6 of SPEC):**
  - Writes *feel* instant (optimistic) — never block on the LLM.
  - Reads hit a **maintained snapshot**, not a full event re-fold; brief/nudges/stats are pure
    functions over the snapshot, cached.
  - Realtime **patches the changed entity** into client state; no full `/state` re-pull on every
    change.
  - The LLM is off the hot read path entirely; unambiguous updates take a deterministic fast path and
    skip the model.
- **Correctness of derived views:** nudges/brief/stats never contradict the underlying events;
  deferred/closed items excluded consistently; conflicts surfaced, never silently resolved.
- **Privacy:** team data isolated by `team_space_id`; members never see other teams. **Within a team,
  visibility is symmetric by design — there is no per-member hidden data.**
- **Reversibility & audit:** every state change is an attributed, utterance-linked, retractable event.

## 9. Calibration data — capture now, surface carefully

V1's "confidence = belief work will land" quietly produces the rarest management artifact: a
per-person, per-team record of *predicted vs. actual* delivery. The council flagged both its value
(it makes the brief eerily good over time) and its danger (surfaced wrong, it's a surveillance
scoreboard).

**V2 stance:**
- **Capture** every confidence call and its resolution from day one (it's free — it's just events).
- **Do not surface** cross-member scoreboards, rankings, or any one-way reputation in this pass.
- A member's **own** track record is visible to them first; any team-level view of it obeys the
  **symmetry** invariant (if a lead can see yours, you can see theirs) and is deferred until the core
  is solid.

## 10. Edge cases & failure modes (requirements, not afterthoughts)

All of these collapse to one root the council named: *state is a lossy interpretation of speech with
no source of truth.* Event-sourcing is the fix; these are the acceptance criteria.

| Case | Required behavior |
|---|---|
| Ambiguous / unstated owner | Stays **visibly unowned** ("needs an owner"); never auto-assigned. |
| "I'll do it" / "me" / "self" | Not an assignment; offer the author a one-tap "assign me." |
| Two conflicting updates | Both stored as claims; entity flagged; surfaced as *needs-decision*; resolve in one tap. |
| LLM misinterpretation | Reversible, attributed event + always-visible correction; optimistic state rolls back on failure. |
| Realtime race (two edits, same row) | Append-only events; latest non-retracted event wins per field; both retained in history. |
| Confidence misread | Reframed + owner-set (§7); labeled, never a % done bar. |
| Stale / contradictory state | Events are timestamped + attributed; "why is this here?" is always answerable. |
| Member leaves the team | Their events remain (history is history); attribution tombstoned; retention/anonymization is an explicit setting (default: retain, attribute as "former member"). |
| Empty team / day one | Designed cold-start (seeded example or guided first update); never a blank dead end. |
| Failed transcription / no AI key | Deterministic fallback parser; audio path fails loudly with a clear message, never a silent 500. |

## 11. Success metrics

- **Activation:** % of new members who log ≥1 real update in week 1 — **measured for non-founders
  specifically** (the wedge working = ICs adopting).
- **Symmetric engagement:** ratio of non-founder to founder reads/writes (V1's failure mode was this
  ratio near zero).
- **Capture habit:** updates logged per active user per week.
- **Proactive value:** nudge reply/act rate; brief opens per active user.
- **Trust:** rate of "answer was wrong/invented" reports → near zero; **undo/correction rate** as a
  health signal (some is healthy — it means people trust it enough to fix it; a spike means interpret
  is drifting).
- **Speed:** p95 write-to-visible (optimistic, target <100ms) and interpret-reconcile latency.
- **Retention:** weekly active teams retained at 4 weeks.

## 12. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Teammates won't narrate to a tool (the load-bearing assumption) | Give the IC a self-interested wedge (My Plate + pushback) before asking them to feed it; keep capture one-tap and optional. |
| "Quiet chief of staff" reads as surveillance | Symmetry invariant (Principle 5) enforced in RLS and UI; no one-way visibility anywhere. |
| Jargon buries the value | De-jargon requirements (§7) treated as P0 acceptance criteria. |
| Optimistic writes hide a wrong interpretation | Always-visible per-utterance "fix/undo"; failed interpret rolls back visibly. |
| Derive-on-read melts at scale | Snapshot + cache + targeted realtime patch; LLM off the hot path (SPEC §6). |
| Event-sourcing over-engineered for a solo maintainer | Keep the fold simple (latest-non-retracted-event-wins per field); snapshot table looks like V1's `field_objects`, so most ported code still applies. |
| Scope creep into Jira / platform | §6.7 out-of-scope list is a contract; calibration captured not surfaced (§9). |
| Conflicting updates mishandled | First-class "two claims" model (§10) instead of last-write-wins. |

## 13. Open questions / next moves

1. **Confirm the optimistic-write UX in practice** — validate that the always-visible "fix" affordance
   is discoverable enough that wrong writes get caught (the one risk of optimistic-over-confirm).
2. **Offboarding retention default** — retain-and-tombstone vs. anonymize; pick before GA.
3. **When to surface calibration** — only after the symmetric core is proven; design the team-level
   view to honor symmetry.
4. **Passive ingestion** — revisit as the post-V2 wedge once narration habit is validated.
5. **Push delivery** — still the eventual "make nudges leave the app" step; derive+cache keeps it
   trivially addable.
