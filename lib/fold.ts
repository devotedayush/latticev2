// Lattice V2 — pure TypeScript fold (mirror of the SQL `lattice_fold_entity`).
//
// The server doesn't need this — the DB trigger maintains `entities`. This exists
// for the CLIENT: to render an optimistic snapshot the instant an update is sent,
// before the server round-trip returns the authoritative rows. Keeping it a pure
// function over events means the optimistic preview can never disagree with the
// model's definition of state (Principle 4 / 10).

import type { Entity, EntityConflict, EntityPatch, LatticeEvent } from "@/lib/events";
import type { FieldObjectType } from "@/lib/lattice";

const CONFLICT_FIELDS = new Set(["due_at", "status", "owner"]);
const CONFLICT_WINDOW_MS = 48 * 60 * 60 * 1000;

type Setter = { actor: string | null; value: unknown; at: number };

// Fold a single entity's events (already filtered to one entity_id) in seq order.
function foldOne(teamSpaceId: string, entityId: string, evs: LatticeEvent[]): Entity | null {
  // active = not a retraction, not retracted, not superseded by a retraction
  const retractedIds = new Set<string>();
  for (const e of evs) {
    if (e.kind === "retraction" && e.supersedes) retractedIds.add(e.supersedes);
  }
  const active = evs
    .filter((e) => e.kind !== "retraction" && !retractedIds.has(e.id))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  if (active.length === 0) return null;

  const state: EntityPatch & { confidence?: number } = {};
  const setters = new Map<string, Setter>();
  let conflict: EntityConflict | null = null;
  let type: FieldObjectType = "signal";
  const createdAt = active[0].created_at ?? new Date().toISOString();
  let updatedAt = createdAt;
  let lastSeq = 0;

  for (const ev of active) {
    if (ev.entity_type) type = ev.entity_type;
    const evAt = ev.created_at ? Date.parse(ev.created_at) : Date.now();
    updatedAt = ev.created_at ?? updatedAt;
    lastSeq = ev.seq ?? lastSeq;

    if (ev.after) {
      for (const [k, v] of Object.entries(ev.after)) {
        if (CONFLICT_FIELDS.has(k)) {
          const prev = setters.get(k);
          if (
            prev &&
            JSON.stringify(prev.value) !== JSON.stringify(v) &&
            prev.actor !== (ev.actor_name ?? null) &&
            evAt - prev.at < CONFLICT_WINDOW_MS
          ) {
            conflict = {
              field: k,
              claims: [
                { actor: prev.actor, value: prev.value, at: new Date(prev.at).toISOString() },
                { actor: ev.actor_name ?? null, value: v, at: ev.created_at ?? new Date(evAt).toISOString() },
              ],
            };
          }
          setters.set(k, { actor: ev.actor_name ?? null, value: v, at: evAt });
        }
        (state as Record<string, unknown>)[k] = v;
      }
    }
    if (typeof ev.confidence === "number") state.confidence = ev.confidence;
  }

  const owner = state.owner && String(state.owner).trim() ? String(state.owner) : null;

  return {
    id: entityId,
    team_space_id: teamSpaceId,
    type,
    title: state.title ?? "",
    detail: state.detail ?? "",
    owner,
    status: state.status ?? null,
    confidence: typeof state.confidence === "number" ? state.confidence : 0.7,
    pulse: state.pulse ?? "quiet",
    links: Array.isArray(state.links) ? state.links : [],
    due_at: state.due_at ?? null,
    deferred_until: state.deferred_until ?? null,
    decline_reason: state.decline_reason ?? null,
    conflict,
    last_event_seq: lastSeq,
    unowned: owner === null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

// Fold a whole event stream into the current snapshot.
export function foldEntities(teamSpaceId: string, events: LatticeEvent[]): Entity[] {
  const byEntity = new Map<string, LatticeEvent[]>();
  for (const e of events) {
    if (!e.entity_id) continue;
    const list = byEntity.get(e.entity_id) ?? [];
    list.push(e);
    byEntity.set(e.entity_id, list);
  }
  const out: Entity[] = [];
  for (const [entityId, evs] of byEntity) {
    const folded = foldOne(teamSpaceId, entityId, evs);
    if (folded) out.push(folded);
  }
  return out;
}

// Optimistically merge newly-emitted events into an existing snapshot, returning
// the updated entity list. Used by the client between send and server reconcile.
export function applyOptimistic(
  teamSpaceId: string,
  current: Entity[],
  newEvents: LatticeEvent[],
): Entity[] {
  const folded = foldEntities(teamSpaceId, newEvents);
  const map = new Map(current.map((e) => [e.id, e]));
  for (const e of folded) map.set(e.id, { ...map.get(e.id), ...e });
  return [...map.values()];
}
