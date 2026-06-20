// Lattice V2 — event-sourced core (client of the live DB layer).
//
// Truth = `utterances` + append-only `events`. The current snapshot (`entities`)
// is maintained by a Postgres trigger (`lattice_after_event` → `lattice_fold_entity`),
// so the server only needs to INSERT events; the snapshot folds itself.
//
// This module: shared types, the envelope→events translation, and the DB helpers
// that write a capture (utterance + events) and read the snapshot back.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FieldObjectType } from "@/lib/lattice";
import type { InterpretationV2 } from "@/lib/v2";

export type EventKind =
  | "entity_created"
  | "entity_updated"
  | "owner_change"
  | "due_change"
  | "confidence_change"
  | "status_change"
  | "blocker_emerged"
  | "blocker_resolved"
  | "goal_shift"
  | "scope_change"
  | "assumption_changed"
  | "intervention_suggested"
  | "deferral"
  | "decline"
  | "retraction"
  | "note";

// A field-level patch applied to an entity. Keys match `entities` columns.
export type EntityPatch = Partial<{
  title: string;
  detail: string;
  owner: string | null;
  status: string;
  pulse: string;
  links: string[];
  due_at: string | null;
  deferred_until: string | null;
  decline_reason: string | null;
}>;

export type LatticeEvent = {
  id: string;
  team_space_id: string;
  seq?: number;
  utterance_id?: string | null;
  actor_user_id?: string | null;
  actor_name?: string | null;
  kind: EventKind;
  entity_id?: string | null;
  entity_type?: FieldObjectType | null;
  before?: Record<string, unknown> | null;
  after?: EntityPatch | null;
  confidence?: number | null;
  supersedes?: string | null;
  source?: string;
  created_at?: string;
};

export type EntityConflict = {
  field: string;
  claims: { actor: string | null; value: unknown; at: string }[];
};

// The derived snapshot row — mirrors the `entities` table.
export type Entity = {
  id: string;
  team_space_id: string;
  type: FieldObjectType;
  title: string;
  detail: string;
  owner: string | null;
  status: string | null;
  confidence: number;
  pulse: string;
  links: string[];
  due_at: string | null;
  deferred_until: string | null;
  decline_reason: string | null;
  conflict: EntityConflict | null;
  last_event_seq: number;
  unowned: boolean;
  created_at: string;
  updated_at: string;
};

export type CaptureContext = {
  teamSpaceId: string;
  actorName: string | null;
  actorUserId: string | null;
  utteranceId: string | null;
};

let counter = 0;
function genId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

// Per-type defaults applied on creation. Owner is NEVER defaulted — an entity
// with no stated owner stays unowned (Principle 8).
function defaultsForType(type: FieldObjectType): { status?: string; pulse: string } {
  switch (type) {
    case "blocker":
      return { status: "open", pulse: "tense" };
    case "promise":
      return { status: "in_progress", pulse: "active" };
    case "request":
      return { status: "new", pulse: "quiet" };
    case "reminder":
      return { status: "open", pulse: "warm" };
    default:
      return { pulse: "quiet" };
  }
}

// Translate an interpret envelope into events. Entities become creation events;
// a goal shift becomes a goal_shift note event. Each entity gets a fresh id so
// the caller can render it optimistically before the server responds.
export function envelopeToEvents(
  interpretation: InterpretationV2,
  ctx: CaptureContext,
): LatticeEvent[] {
  const events: LatticeEvent[] = [];

  for (const ent of interpretation.entities ?? []) {
    const entityId = genId(ent.type.slice(0, 3));
    const defs = defaultsForType(ent.type);
    const owner = ent.owner?.trim() ? ent.owner.trim() : null; // never invent

    const after: EntityPatch = {
      title: ent.title,
      detail: ent.detail ?? "",
      owner,
      pulse: defs.pulse,
    };
    if (defs.status) after.status = defs.status;
    if (ent.dueAt) after.due_at = ent.dueAt;
    if (ent.linkedTo) after.links = [ent.linkedTo];

    events.push({
      id: genId("evt"),
      team_space_id: ctx.teamSpaceId,
      utterance_id: ctx.utteranceId,
      actor_user_id: ctx.actorUserId,
      actor_name: ctx.actorName,
      kind: ent.type === "blocker" ? "blocker_emerged" : "entity_created",
      entity_id: entityId,
      entity_type: ent.type,
      after,
      confidence: typeof ent.confidence === "number" ? ent.confidence : null,
      source: "interpretation",
    });
  }

  if (interpretation.goalShift) {
    events.push({
      id: genId("evt"),
      team_space_id: ctx.teamSpaceId,
      utterance_id: ctx.utteranceId,
      actor_user_id: ctx.actorUserId,
      actor_name: ctx.actorName,
      kind: "goal_shift",
      after: { detail: interpretation.goalShift.title },
      confidence:
        typeof interpretation.goalShift.confidence === "number"
          ? interpretation.goalShift.confidence
          : null,
      source: "interpretation",
    });
  }

  return events;
}

// Insert a capture: one utterance + its events. The DB trigger folds the
// affected entities automatically, so we just read the snapshot back.
export async function applyCaptureToDatabase(
  supabase: SupabaseClient,
  args: { input: string; interpretation: InterpretationV2; ctx: Omit<CaptureContext, "utteranceId"> },
): Promise<{ events: LatticeEvent[]; entities: Entity[] }> {
  const utteranceId = genId("utt");

  const { error: uErr } = await supabase.from("utterances").insert({
    id: utteranceId,
    team_space_id: args.ctx.teamSpaceId,
    actor_user_id: args.ctx.actorUserId,
    actor_name: args.ctx.actorName,
    raw_text: args.input,
    source: "chat",
    interpretation: args.interpretation,
  });
  if (uErr) throw new Error(`utterance insert failed: ${uErr.message}`);

  const events = envelopeToEvents(args.interpretation, { ...args.ctx, utteranceId });
  if (events.length > 0) {
    const { error: eErr } = await supabase.from("events").insert(events);
    if (eErr) throw new Error(`events insert failed: ${eErr.message}`);
  }

  const entities = await fetchEntities(supabase, args.ctx.teamSpaceId);
  return { events, entities };
}

// Append a retraction event that supersedes `eventId`. The trigger re-folds the
// affected entity, removing the retracted event's contribution. This is undo.
export async function retractEvent(
  supabase: SupabaseClient,
  args: { teamSpaceId: string; eventId: string; actorName: string | null; actorUserId: string | null },
): Promise<Entity[]> {
  const { data: target, error: tErr } = await supabase
    .from("events")
    .select("id, entity_id")
    .eq("id", args.eventId)
    .eq("team_space_id", args.teamSpaceId)
    .maybeSingle();
  if (tErr) throw new Error(`undo lookup failed: ${tErr.message}`);
  if (!target) throw new Error("event not found");

  const { error: rErr } = await supabase.from("events").insert({
    id: genId("evt"),
    team_space_id: args.teamSpaceId,
    actor_user_id: args.actorUserId,
    actor_name: args.actorName,
    kind: "retraction",
    entity_id: (target as { entity_id: string | null }).entity_id,
    supersedes: args.eventId,
    source: "manual",
  });
  if (rErr) throw new Error(`undo insert failed: ${rErr.message}`);

  return fetchEntities(supabase, args.teamSpaceId);
}

// ----------------------------------------------------------------------------
// Per-entity mutations — each is a reversible event on the stream, not a direct
// row write. The DB trigger re-folds the entity. Mirrors V1's commitment actions.
// ----------------------------------------------------------------------------
export type EntityActionKind =
  | "complete"
  | "resolve"
  | "set_due"
  | "set_owner"
  | "defer"
  | "decline"
  | "drop"
  | "set_confidence";

export async function applyEntityAction(
  supabase: SupabaseClient,
  args: {
    teamSpaceId: string;
    entityId: string;
    entityType: FieldObjectType | null;
    action: EntityActionKind;
    actorName: string | null;
    actorUserId: string | null;
    dueAt?: string | null;
    owner?: string | null;
    deferredUntil?: string | null;
    reason?: string | null;
    confidence?: number | null;
  },
): Promise<Entity[]> {
  let kind: EventKind;
  let after: EntityPatch | null = {};
  let confidence: number | null = null;

  switch (args.action) {
    case "complete":
      kind = "status_change";
      after = { status: "done", pulse: "clear" };
      confidence = 1;
      break;
    case "resolve":
      kind = "blocker_resolved";
      after = { status: "resolved", pulse: "clear" };
      break;
    case "set_due":
      kind = "due_change";
      after = { due_at: args.dueAt ?? null };
      break;
    case "set_owner":
      kind = "owner_change";
      after = { owner: args.owner ?? null };
      break;
    case "defer":
      kind = "deferral";
      after = { deferred_until: args.deferredUntil ?? null, decline_reason: args.reason ?? null, pulse: "stale" };
      break;
    case "decline":
      kind = "decline";
      after = { status: "dropped", decline_reason: args.reason ?? null, pulse: "quiet" };
      break;
    case "drop":
      kind = "scope_change";
      after = { status: "dropped", pulse: "quiet" };
      break;
    case "set_confidence":
      kind = "confidence_change";
      after = null;
      confidence = typeof args.confidence === "number" ? args.confidence : null;
      break;
    default:
      throw new Error("unknown action");
  }

  const { error } = await supabase.from("events").insert({
    id: genId("evt"),
    team_space_id: args.teamSpaceId,
    actor_user_id: args.actorUserId,
    actor_name: args.actorName,
    kind,
    entity_id: args.entityId,
    entity_type: args.entityType,
    after,
    confidence,
    source: "manual",
  });
  if (error) throw new Error(`action insert failed: ${error.message}`);

  return fetchEntities(supabase, args.teamSpaceId);
}

export async function fetchEntities(
  supabase: SupabaseClient,
  teamSpaceId: string,
): Promise<Entity[]> {
  const { data, error } = await supabase
    .from("entities")
    .select("*")
    .eq("team_space_id", teamSpaceId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`entities fetch failed: ${error.message}`);
  return (data ?? []) as Entity[];
}
