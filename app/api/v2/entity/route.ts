// PATCH /api/v2/entity — per-entity mutation on the event path.
// Each action emits a reversible event; the DB folds the snapshot. Owner-gated:
// every action except set_confidence requires the caller to be the current owner
// or a team admin (ported from V1's commitment owner-gate).

import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { applyEntityAction, type EntityActionKind } from "@/lib/events";
import { getUserActiveTeam } from "@/lib/teams";
import type { FieldObjectType } from "@/lib/lattice";

const ACTIONS: EntityActionKind[] = [
  "complete",
  "resolve",
  "set_due",
  "set_owner",
  "defer",
  "decline",
  "drop",
  "set_confidence",
];

export async function PATCH(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: {
    id?: string;
    action?: string;
    teamId?: string;
    dueAt?: string | null;
    owner?: string | null;
    deferredUntil?: string | null;
    reason?: string | null;
    confidence?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.id || !body.action || !(ACTIONS as string[]).includes(body.action)) {
    return NextResponse.json({ error: "id and a valid action are required." }, { status: 400 });
  }
  const action = body.action as EntityActionKind;
  if (action === "set_confidence" && typeof body.confidence !== "number") {
    return NextResponse.json({ error: "confidence (number) required." }, { status: 400 });
  }
  if (action === "defer" && !body.deferredUntil) {
    return NextResponse.json({ error: "deferredUntil required." }, { status: 400 });
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const { data: ent } = await auth.supabase
      .from("entities")
      .select("owner, type")
      .eq("team_space_id", team.id)
      .eq("id", body.id)
      .maybeSingle();
    if (!ent) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const entity = ent as { owner: string | null; type: FieldObjectType };

    // owner-gate (set_confidence is the one ungated action)
    if (action !== "set_confidence") {
      const { data: me } = await auth.supabase
        .from("team_members")
        .select("name, role")
        .eq("team_space_id", team.id)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      const m = me as { name?: string; role?: string } | null;
      const isAdmin = m?.role === "owner" || m?.role === "admin";
      const owns =
        !!entity.owner &&
        !!m?.name &&
        entity.owner.trim().toLowerCase() === m.name.trim().toLowerCase();
      if (!isAdmin && !owns) {
        return NextResponse.json(
          { error: "Only the current owner (or a team admin) can change this." },
          { status: 403 },
        );
      }
    }

    const { data: me2 } = await auth.supabase
      .from("team_members")
      .select("name")
      .eq("team_space_id", team.id)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    const actorName = (me2 as { name?: string } | null)?.name ?? null;

    const entities = await applyEntityAction(auth.supabase, {
      teamSpaceId: team.id,
      entityId: body.id,
      entityType: entity.type,
      action,
      actorName,
      actorUserId: auth.user.id,
      dueAt: body.dueAt,
      owner: body.owner,
      deferredUntil: body.deferredUntil,
      reason: body.reason,
      confidence: body.confidence,
    });

    return NextResponse.json({ entities, team });
  } catch (err) {
    console.error("/api/v2/entity failed", err);
    return NextResponse.json({ error: "Action failed." }, { status: 500 });
  }
}
