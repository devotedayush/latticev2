// Lattice V2 — the symmetric read layer.
//
// There aren't three user types — there's one person in three postures. The
// teammate ("my plate"), the lead ("the team"), and the founder ("what's
// slipping") are the SAME query, parameterized by who's asking. Visibility is
// symmetric: any member may request any lens for anyone. Roles gate mutation
// (which buttons render), never what you can see.

import type { Entity } from "@/lib/events";

export type Lens = "mine" | "team" | "missing";

export type Viewer = {
  userId: string;
  memberName: string;
  role: "owner" | "admin" | "member";
};

const CLOSED_STATUSES = new Set(["done", "resolved", "dropped", "declined"]);

function isOpen(e: Entity): boolean {
  return !e.status || !CLOSED_STATUSES.has(e.status);
}

function isDeferred(e: Entity): boolean {
  return !!e.deferred_until && Date.parse(e.deferred_until) > Date.now();
}

function ownedBy(e: Entity, name: string): boolean {
  return !!e.owner && e.owner.trim().toLowerCase() === name.trim().toLowerCase();
}

function dueSoon(e: Entity, withinHours = 48): boolean {
  if (!e.due_at) return false;
  const ms = Date.parse(e.due_at) - Date.now();
  return ms <= withinHours * 3600_000;
}

function isOverdue(e: Entity): boolean {
  return !!e.due_at && Date.parse(e.due_at) < Date.now() && isOpen(e);
}

export type MyPlateView = {
  lens: "mine";
  owned: Entity[];
  load: { open: number; dueSoon: number; overdue: number };
  owedToMe: Entity[]; // blockers others own that gate my work, requests targeting me
  conflicts: Entity[];
};

export type TeamView = {
  lens: "team";
  byType: Record<string, Entity[]>;
  blockers: Entity[];
  overloaded: { owner: string; count: number }[];
  conflicts: Entity[];
};

export type MissingView = {
  lens: "missing";
  changed: Entity[]; // most recently updated, open
  atRisk: Entity[]; // open blockers + low-confidence promises
  needsDecision: Entity[]; // conflicts + unowned blockers
};

export type ViewModel = MyPlateView | TeamView | MissingView;

export function deriveView(entities: Entity[], viewer: Viewer, lens: Lens): ViewModel {
  const live = entities.filter((e) => !isDeferred(e));

  if (lens === "mine") {
    const owned = live.filter((e) => ownedBy(e, viewer.memberName) && isOpen(e));
    const myIds = new Set(owned.map((e) => e.id));
    const owedToMe = live.filter(
      (e) =>
        isOpen(e) &&
        !ownedBy(e, viewer.memberName) &&
        (e.type === "blocker" || e.type === "request") &&
        (e.links ?? []).some((l) => myIds.has(l)),
    );
    return {
      lens: "mine",
      owned: sortByUrgency(owned),
      load: {
        open: owned.length,
        dueSoon: owned.filter((e) => dueSoon(e)).length,
        overdue: owned.filter((e) => isOverdue(e)).length,
      },
      owedToMe,
      conflicts: owned.filter((e) => e.conflict),
    };
  }

  if (lens === "team") {
    const byType: Record<string, Entity[]> = {};
    for (const e of live) {
      (byType[e.type] ??= []).push(e);
    }
    for (const k of Object.keys(byType)) byType[k] = sortByUrgency(byType[k]);
    const blockers = live.filter((e) => e.type === "blocker" && isOpen(e));
    const load = new Map<string, number>();
    for (const b of blockers) {
      const o = b.owner ?? "Unassigned";
      load.set(o, (load.get(o) ?? 0) + 1);
    }
    return {
      lens: "team",
      byType,
      blockers,
      overloaded: [...load.entries()]
        .filter(([, c]) => c >= 2)
        .map(([owner, count]) => ({ owner, count })),
      conflicts: live.filter((e) => e.conflict),
    };
  }

  // lens === "missing"
  const open = live.filter(isOpen);
  return {
    lens: "missing",
    changed: [...open]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 5),
    atRisk: open.filter(
      (e) => (e.type === "blocker") || (e.type === "promise" && e.confidence < 0.5),
    ),
    needsDecision: open.filter((e) => e.conflict || (e.type === "blocker" && e.unowned)),
  };
}

// Sort: overdue first, then due-soonest, then undated. Closed sink to the end.
function sortByUrgency(list: Entity[]): Entity[] {
  const rank = (e: Entity): number => {
    if (!isOpen(e)) return 1e15;
    if (!e.due_at) return 1e14;
    return Date.parse(e.due_at);
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}
