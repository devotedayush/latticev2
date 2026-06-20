// POST /api/v2/undo — retract an event. Appends a `retraction` event that
// supersedes the target; the DB trigger re-folds the affected entity, removing
// the retracted contribution. History is preserved (the event still exists).

import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { retractEvent } from "@/lib/events";
import { getUserActiveTeam } from "@/lib/teams";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { eventId?: string; teamId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.eventId) {
    return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const { data: me } = await auth.supabase
      .from("team_members")
      .select("name")
      .eq("team_space_id", team.id)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    const actorName = (me as { name?: string } | null)?.name ?? null;

    const entities = await retractEvent(auth.supabase, {
      teamSpaceId: team.id,
      eventId: body.eventId,
      actorName,
      actorUserId: auth.user.id,
    });

    return NextResponse.json({ entities, team });
  } catch (err) {
    console.error("/api/v2/undo failed", err);
    return NextResponse.json({ error: "Undo failed." }, { status: 500 });
  }
}
