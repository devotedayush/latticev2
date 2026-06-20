// GET /api/v2/entities?team=...&lens=mine|team|missing
// Returns the derived snapshot, optionally shaped through a lens for the caller.
// Visibility is symmetric — any member can request any lens for the team.

import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { fetchEntities } from "@/lib/events";
import { deriveView, type Lens } from "@/lib/view";
import { getUserActiveTeam } from "@/lib/teams";

const LENSES: Lens[] = ["mine", "team", "missing"];

export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const teamId = url.searchParams.get("team");
  const lensParam = url.searchParams.get("lens");
  const lens: Lens | null = lensParam && (LENSES as string[]).includes(lensParam) ? (lensParam as Lens) : null;

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, teamId);
    if (!team) return NextResponse.json({ entities: [], view: null, team: null });

    const entities = await fetchEntities(auth.supabase, team.id);

    let view = null;
    if (lens) {
      const { data: me } = await auth.supabase
        .from("team_members")
        .select("name, role")
        .eq("team_space_id", team.id)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      const m = me as { name?: string; role?: "owner" | "admin" | "member" } | null;
      view = deriveView(entities, {
        userId: auth.user.id,
        memberName: m?.name ?? "",
        role: m?.role ?? "member",
      }, lens);
    }

    return NextResponse.json({ entities, view, team });
  } catch (err) {
    console.error("/api/v2/entities failed", err);
    return NextResponse.json({ error: "Fetch failed." }, { status: 500 });
  }
}
