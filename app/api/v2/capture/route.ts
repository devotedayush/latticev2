// POST /api/v2/capture — V2 event-path interpret+apply.
// NL update → interpretV2 envelope → utterance + events → DB folds the snapshot.
// Returns the emitted events + the fresh entities snapshot so the client can
// reconcile its optimistic state and show the per-utterance "fix/undo" affordance.

import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { interpretV2 } from "@/lib/ai-v2";
import { applyCaptureToDatabase } from "@/lib/events";
import { getUserActiveTeam, listTeamMembers } from "@/lib/teams";
import { fetchLatticeState } from "@/lib/v2-db";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { input?: string; teamId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "Input is required." }, { status: 400 });
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team — create one first." }, { status: 400 });

    const [currentState, members] = await Promise.all([
      fetchLatticeState(auth.supabase, team.id),
      listTeamMembers(auth.supabase, team.id).catch(() => []),
    ]);

    // actor's display name (for attribution + symmetric owner matching)
    const { data: me } = await auth.supabase
      .from("team_members")
      .select("name")
      .eq("team_space_id", team.id)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    const actorName = (me as { name?: string } | null)?.name ?? null;

    const interpretation = await interpretV2(input, currentState, members);

    const { events, entities } = await applyCaptureToDatabase(auth.supabase, {
      input,
      interpretation,
      ctx: { teamSpaceId: team.id, actorName, actorUserId: auth.user.id },
    });

    return NextResponse.json({ interpretation, events, entities, team });
  } catch (err) {
    console.error("/api/v2/capture failed", err);
    return NextResponse.json({ error: "Capture failed." }, { status: 500 });
  }
}
