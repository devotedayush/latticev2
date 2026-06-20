"use client";

// Lattice V2 client — wired to the event-sourced core.
// Capture → /api/v2/capture (utterance + events → snapshot). Undo → /api/v2/undo.
// Reads → /api/v2/entities, shaped client-side through deriveView (mine/team/missing).
// Surface is de-jargoned: no primitive type-name ("promise"/"signal"/"shift") is shown.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";

import { createSupabaseBrowserClient } from "@/lib/supabase";
import type { Entity, LatticeEvent } from "@/lib/events";
import { deriveView, type Lens, type Viewer } from "@/lib/view";
import type { FieldObjectType } from "@/lib/lattice";

// ---- de-jargon: human labels, never the internal type-names ----
const TYPE_LABEL: Record<FieldObjectType, string> = {
  promise: "Commitment",
  blocker: "Blocker",
  request: "Ask",
  reminder: "Reminder",
  shift: "Direction change",
  signal: "Heads-up",
  intent: "Direction",
};

const LENS_LABEL: Record<Lens, string> = {
  mine: "My plate",
  team: "The team",
  missing: "What's slipping",
};

type TeamSummary = { id: string; name: string; role?: "owner" | "admin" | "member" };

type PatchPayload = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
};

// Apply a single realtime change to the local snapshot — upsert on INSERT/UPDATE,
// remove on DELETE. deriveView re-sorts per lens, so insertion order is irrelevant.
function patchEntities(cur: Entity[], p: PatchPayload): Entity[] {
  if (p.eventType === "DELETE") {
    const id = (p.old as { id?: string } | undefined)?.id;
    return id ? cur.filter((e) => e.id !== id) : cur;
  }
  const row = p.new as Entity | undefined;
  if (!row?.id) return cur;
  const idx = cur.findIndex((e) => e.id === row.id);
  if (idx === -1) return [row, ...cur];
  const next = cur.slice();
  next[idx] = row;
  return next;
}

export default function Page() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [me, setMe] = useState<{ name: string; role: "owner" | "admin" | "member" }>({
    name: "",
    role: "member",
  });
  const [members, setMembers] = useState<string[]>([]);
  const [needsTeam, setNeedsTeam] = useState(false);

  const [entities, setEntities] = useState<Entity[]>([]);
  const [lens, setLens] = useState<Lens>("mine");
  const [recorded, setRecorded] = useState<LatticeEvent[]>([]);
  const [pending, setPending] = useState<{ text: string; status: "interpreting" | "error" } | null>(
    null,
  );
  const [updatedIds, setUpdatedIds] = useState<Set<string>>(() => new Set());

  const authedFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const { data } = await supabase!.auth.getSession();
      const token = data.session?.access_token;
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      // Never force JSON on FormData/Blob — it stomps the multipart boundary and
      // breaks voice upload (the V1 bug). Only set JSON for plain string bodies.
      const isMultipart = init.body instanceof FormData || init.body instanceof Blob;
      if (init.body && !isMultipart && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      return fetch(path, { ...init, headers });
    },
    [supabase],
  );

  // brief highlight when a row changes via realtime
  const flash = useCallback((id: string) => {
    setUpdatedIds((s) => new Set(s).add(id));
    setTimeout(() => {
      setUpdatedIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }, 2000);
  }, []);

  // ---- auth ----
  useEffect(() => {
    if (!supabase) {
      setCheckingAuth(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingAuth(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) {
        setTeams([]);
        setActiveTeamId(null);
        setEntities([]);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  // ---- teams ----
  const loadTeams = useCallback(async () => {
    const res = await authedFetch("/api/v2/teams");
    const data = await res.json().catch(() => ({ teams: [] }));
    const list: TeamSummary[] = data.teams ?? [];
    setTeams(list);
    setNeedsTeam(list.length === 0);
    setActiveTeamId((cur) => cur ?? list[0]?.id ?? null);
  }, [authedFetch]);

  useEffect(() => {
    if (session) loadTeams();
  }, [session, loadTeams]);

  const loadEntities = useCallback(
    async (teamId: string) => {
      const res = await authedFetch(`/api/v2/entities?team=${encodeURIComponent(teamId)}`);
      const data = await res.json().catch(() => ({ entities: [] }));
      setEntities(data.entities ?? []);
    },
    [authedFetch],
  );

  // load member identity + entities + realtime when active team changes
  useEffect(() => {
    if (!supabase || !session || !activeTeamId) return;
    let cancelled = false;

    supabase
      .from("team_members")
      .select("name, role")
      .eq("team_space_id", activeTeamId)
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setMe({ name: data.name ?? "", role: data.role ?? "member" });
      });

    supabase
      .from("team_members")
      .select("name")
      .eq("team_space_id", activeTeamId)
      .then(({ data }) => {
        if (!cancelled && data)
          setMembers((data as { name: string | null }[]).map((r) => r.name ?? "").filter(Boolean));
      });

    loadEntities(activeTeamId); // one initial snapshot; realtime patches from here

    // TRUE PATCHING: subscribe to the folded `entities` snapshot. Each message
    // carries the changed row — apply it in place; no full re-pull.
    const channel = supabase
      .channel(`lattice-entities-${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "entities", filter: `team_space_id=eq.${activeTeamId}` },
        (payload) => {
          const p = payload as unknown as PatchPayload;
          setEntities((cur) => patchEntities(cur, p));
          const id = (p.new as { id?: string } | undefined)?.id ?? (p.old as { id?: string } | undefined)?.id;
          if (id) flash(id);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [supabase, session, activeTeamId, loadEntities, flash]);

  // ---- capture (optimistic echo, reconcile on response) ----
  const capture = useCallback(
    async (text: string) => {
      if (!activeTeamId || !text.trim()) return;
      setPending({ text: text.trim(), status: "interpreting" });
      try {
        const res = await authedFetch("/api/v2/capture", {
          method: "POST",
          body: JSON.stringify({ input: text.trim(), teamId: activeTeamId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "capture failed");
        setEntities(data.entities ?? []);
        setRecorded(data.events ?? []);
        setPending(null);
      } catch {
        setPending({ text: text.trim(), status: "error" });
      }
    },
    [authedFetch, activeTeamId],
  );

  const transcribe = useCallback(
    async (blob: Blob, ext: string): Promise<string> => {
      const form = new FormData();
      form.append("audio", blob, `update.${ext}`);
      const res = await authedFetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.text) throw new Error(data?.error ?? "Transcription failed.");
      return data.text as string;
    },
    [authedFetch],
  );

  const undo = useCallback(
    async (eventId: string) => {
      if (!activeTeamId) return;
      const res = await authedFetch("/api/v2/undo", {
        method: "POST",
        body: JSON.stringify({ eventId, teamId: activeTeamId }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        setEntities(data.entities ?? []);
        setRecorded((r) => r.filter((e) => e.id !== eventId));
      }
    },
    [authedFetch, activeTeamId],
  );

  const entityAction = useCallback(
    async (id: string, action: string, extra: Record<string, unknown> = {}) => {
      if (!activeTeamId) return;
      const res = await authedFetch("/api/v2/entity", {
        method: "PATCH",
        body: JSON.stringify({ id, action, teamId: activeTeamId, ...extra }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) setEntities(data.entities ?? []);
    },
    [authedFetch, activeTeamId],
  );

  const canMutate = useCallback(
    (e: Entity) => {
      if (me.role === "owner" || me.role === "admin") return true;
      return (
        !!e.owner && !!me.name && e.owner.trim().toLowerCase() === me.name.trim().toLowerCase()
      );
    },
    [me],
  );

  const createTeam = useCallback(
    async (name: string) => {
      const res = await authedFetch("/api/v2/teams", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.team) {
        setNeedsTeam(false);
        await loadTeams();
        setActiveTeamId(data.team.id);
      }
    },
    [authedFetch, loadTeams],
  );

  const view = useMemo(() => {
    const viewer: Viewer = { userId: session?.user.id ?? "", memberName: me.name, role: me.role };
    return deriveView(entities, viewer, lens);
  }, [entities, session, me.name, me.role, lens]);

  const actions: CardActions = { members, canMutate, onAction: entityAction, recent: updatedIds };

  // ---- render gates ----
  if (checkingAuth) return <div className="centered">Loading…</div>;
  if (!supabase)
    return <div className="centered">Supabase isn’t configured. Add keys to .env.local.</div>;
  if (!session) return <AuthGate supabase={supabase} />;
  if (needsTeam) return <TeamGate onCreate={createTeam} />;

  return (
    <div className="v2-shell">
      <header className="v2-top">
        <div className="v2-brand">Lattice</div>
        <div className="v2-team">
          {teams.length > 1 ? (
            <select value={activeTeamId ?? ""} onChange={(e) => setActiveTeamId(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{teams[0]?.name}</span>
          )}
          <button className="v2-link" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <Composer
        onCapture={capture}
        pending={pending}
        recorded={recorded}
        onUndo={undo}
        transcribe={transcribe}
      />

      <nav className="v2-lenses">
        {(["mine", "team", "missing"] as Lens[]).map((l) => (
          <button key={l} className={`v2-lens ${lens === l ? "active" : ""}`} onClick={() => setLens(l)}>
            {LENS_LABEL[l]}
          </button>
        ))}
      </nav>

      <main className="v2-main">
        {view.lens === "mine" && <MyPlate view={view} meName={me.name} actions={actions} />}
        {view.lens === "team" && <TeamLens view={view} actions={actions} />}
        {view.lens === "missing" && <MissingLens view={view} actions={actions} />}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Capture composer
// ----------------------------------------------------------------------------
function Composer({
  onCapture,
  pending,
  recorded,
  onUndo,
  transcribe,
}: {
  onCapture: (t: string) => void;
  pending: { text: string; status: "interpreting" | "error" } | null;
  recorded: LatticeEvent[];
  onUndo: (id: string) => void;
  transcribe: (blob: Blob, ext: string) => Promise<string>;
}) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordedEvents = recorded.filter((e) => e.kind !== "retraction" && e.entity_id);

  async function startVoice() {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = recorder.mimeType || "audio/webm";
        const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size === 0) return;
        setVoiceBusy(true);
        try {
          const t = await transcribe(blob, ext);
          setText((cur) => (cur ? `${cur} ${t}` : t));
        } catch (err) {
          setVoiceError(err instanceof Error ? err.message : "Couldn’t transcribe that.");
        } finally {
          setVoiceBusy(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setVoiceError("Mic access denied or unavailable.");
      setRecording(false);
    }
  }

  function stopVoice() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <section className="v2-capture">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCapture(text);
          setText("");
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What happened? e.g. “Priya’s blocked on the vendor API, demo’s now Friday”"
          aria-label="Tell Lattice what happened"
        />
        <button
          type="button"
          className={`v2-mic ${recording ? "recording" : ""}`}
          onClick={() => (recording ? stopVoice() : startVoice())}
          disabled={voiceBusy}
          aria-label={recording ? "Stop recording" : "Record voice"}
        >
          {voiceBusy ? "…" : recording ? "Stop" : "Speak"}
        </button>
        <button className="v2-primary" type="submit">
          Tell
        </button>
      </form>
      {voiceError && <div className="v2-pending error">{voiceError}</div>}

      {pending && (
        <div className={`v2-pending ${pending.status}`}>
          {pending.status === "interpreting" ? "Recording…" : "Couldn’t record that — try again."}{" "}
          <span className="v2-pending-text">“{pending.text}”</span>
        </div>
      )}

      {recordedEvents.length > 0 && (
        <div className="v2-recorded">
          <span className="v2-recorded-label">Recorded</span>
          {recordedEvents.map((e) => (
            <span key={e.id} className="v2-chip">
              {e.entity_type ? TYPE_LABEL[e.entity_type] : "Update"}: {e.after?.title ?? ""}
              <button className="v2-fix" onClick={() => onUndo(e.id)} title="That’s not right — undo">
                fix
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Entity card (de-jargoned)
// ----------------------------------------------------------------------------
function fmtDue(iso: string | null): { text: string; late: boolean } | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const late = ms < Date.now();
  const d = new Date(ms);
  return { text: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), late };
}

function conflictValue(v: unknown): string {
  if (typeof v !== "string") return String(v);
  const ms = Date.parse(v);
  if (!Number.isNaN(ms))
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return v;
}

type CardActions = {
  members: string[];
  canMutate: (e: Entity) => boolean;
  onAction: (id: string, action: string, extra?: Record<string, unknown>) => void;
  recent: Set<string>;
};

const CLOSED_STATUS = new Set(["done", "resolved", "dropped", "declined"]);
const toIsoEod = (date: string): string => `${date}T23:59:00Z`;

function EntityCard({ e, actions }: { e: Entity; actions?: CardActions }) {
  const due = fmtDue(e.due_at);
  const [editing, setEditing] = useState<null | "due" | "owner" | "defer">(null);
  const [dateVal, setDateVal] = useState("");
  const open = !e.status || !CLOSED_STATUS.has(e.status);
  const mutable = !!actions && actions.canMutate(e) && open;
  const isCommitmentish = e.type === "promise" || e.type === "request";

  return (
    <article className={`v2-card ${e.type} ${actions?.recent?.has(e.id) ? "just-updated" : ""}`}>
      <div className="v2-card-top">
        <span className="v2-type">{TYPE_LABEL[e.type]}</span>
        {e.owner ? (
          <span className="v2-owner">{e.owner}</span>
        ) : (
          <span className="v2-unowned">needs an owner</span>
        )}
      </div>
      <div className="v2-title">{e.title}</div>
      {e.detail && <div className="v2-detail">{e.detail}</div>}

      <div className="v2-meta">
        {!open && <span className="v2-done">{e.status}</span>}
        {due && <span className={due.late ? "v2-late" : ""}>due {due.text}</span>}
        {e.type === "promise" && (
          <span title="How likely this is to land by its date — not % done">
            {Math.round(e.confidence * 100)}% likely
          </span>
        )}
        {e.deferred_until && <span className="v2-deferred">snoozed</span>}
      </div>

      {e.conflict && (
        <div className="v2-conflict">
          Two claims on <b>{e.conflict.field === "due_at" ? "the date" : e.conflict.field}</b>:{" "}
          {e.conflict.claims
            .map((c) => `${c.actor ?? "someone"} → ${conflictValue(c.value)}`)
            .join("  ·  ")}{" "}
          — needs a decision.
        </div>
      )}

      {mutable && actions && (
        <div className="v2-actions">
          {isCommitmentish && (
            <button onClick={() => actions.onAction(e.id, "complete")}>Done</button>
          )}
          {e.type === "blocker" && (
            <button onClick={() => actions.onAction(e.id, "resolve")}>Resolved</button>
          )}
          <button onClick={() => setEditing(editing === "owner" ? null : "owner")}>Reassign</button>
          {(isCommitmentish || e.type === "reminder") && (
            <button onClick={() => setEditing(editing === "due" ? null : "due")}>Set due</button>
          )}
          {isCommitmentish && (
            <button onClick={() => setEditing(editing === "defer" ? null : "defer")}>Can’t do</button>
          )}
          <button onClick={() => actions.onAction(e.id, "drop")}>Drop</button>
        </div>
      )}

      {mutable && actions && editing === "owner" && (
        <div className="v2-editor">
          <select
            defaultValue={e.owner ?? ""}
            onChange={(ev) => {
              actions.onAction(e.id, "set_owner", { owner: ev.target.value || null });
              setEditing(null);
            }}
          >
            <option value="">Unassign</option>
            {actions.members.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {mutable && actions && editing === "due" && (
        <div className="v2-editor">
          <input type="date" value={dateVal} onChange={(ev) => setDateVal(ev.target.value)} />
          <button
            onClick={() => {
              if (dateVal) {
                actions.onAction(e.id, "set_due", { dueAt: toIsoEod(dateVal) });
                setEditing(null);
              }
            }}
          >
            Save
          </button>
          <button
            onClick={() => {
              actions.onAction(e.id, "set_due", { dueAt: null });
              setEditing(null);
            }}
          >
            Clear
          </button>
        </div>
      )}

      {mutable && actions && editing === "defer" && (
        <div className="v2-editor">
          <span>Snooze until</span>
          <input type="date" value={dateVal} onChange={(ev) => setDateVal(ev.target.value)} />
          <button
            onClick={() => {
              if (dateVal) {
                actions.onAction(e.id, "defer", {
                  deferredUntil: toIsoEod(dateVal),
                  reason: "plan changed",
                });
                setEditing(null);
              }
            }}
          >
            Save
          </button>
        </div>
      )}
    </article>
  );
}

// ----------------------------------------------------------------------------
// Lenses
// ----------------------------------------------------------------------------
function MyPlate({
  view,
  meName,
  actions,
}: {
  view: Extract<ReturnType<typeof deriveView>, { lens: "mine" }>;
  meName: string;
  actions: CardActions;
}) {
  return (
    <div className="v2-lens-body">
      <div className="v2-load">
        <strong>{view.load.open}</strong> on your plate
        {view.load.dueSoon > 0 && <> · {view.load.dueSoon} due soon</>}
        {view.load.overdue > 0 && (
          <>
            {" "}
            · <span className="v2-late">{view.load.overdue} overdue</span>
          </>
        )}
      </div>

      {meName.trim() === "" && (
        <p className="v2-hint">Set your name in the team so work can be routed to you.</p>
      )}

      {view.owned.length === 0 ? (
        <p className="v2-empty">Nothing owed by you right now.</p>
      ) : (
        view.owned.map((e) => <EntityCard key={e.id} e={e} actions={actions} />)
      )}

      {view.owedToMe.length > 0 && (
        <>
          <h3 className="v2-section">Owed to you</h3>
          {view.owedToMe.map((e) => (
            <EntityCard key={e.id} e={e} actions={actions} />
          ))}
        </>
      )}
    </div>
  );
}

function TeamLens({
  view,
  actions,
}: {
  view: Extract<ReturnType<typeof deriveView>, { lens: "team" }>;
  actions: CardActions;
}) {
  const order: FieldObjectType[] = [
    "blocker",
    "promise",
    "request",
    "reminder",
    "shift",
    "signal",
    "intent",
  ];
  return (
    <div className="v2-lens-body">
      {view.overloaded.length > 0 && (
        <div className="v2-flag">
          Overloaded: {view.overloaded.map((o) => `${o.owner} (${o.count})`).join(", ")}
        </div>
      )}
      {view.conflicts.length > 0 && (
        <div className="v2-flag warn">
          {view.conflicts.length} unresolved conflict(s) — see cards below.
        </div>
      )}
      {order
        .filter((t) => view.byType[t]?.length)
        .map((t) => (
          <div key={t}>
            <h3 className="v2-section">{TYPE_LABEL[t]}</h3>
            {view.byType[t].map((e) => (
              <EntityCard key={e.id} e={e} actions={actions} />
            ))}
          </div>
        ))}
      {Object.keys(view.byType).length === 0 && <p className="v2-empty">No team activity yet.</p>}
    </div>
  );
}

function MissingLens({
  view,
  actions,
}: {
  view: Extract<ReturnType<typeof deriveView>, { lens: "missing" }>;
  actions: CardActions;
}) {
  return (
    <div className="v2-lens-body">
      <h3 className="v2-section">Needs a decision</h3>
      {view.needsDecision.length === 0 ? (
        <p className="v2-empty">Nothing waiting on you to decide.</p>
      ) : (
        view.needsDecision.map((e) => <EntityCard key={e.id} e={e} actions={actions} />)
      )}

      <h3 className="v2-section">At risk</h3>
      {view.atRisk.length === 0 ? (
        <p className="v2-empty">Nothing flagged at risk.</p>
      ) : (
        view.atRisk.map((e) => <EntityCard key={e.id} e={e} actions={actions} />)
      )}

      <h3 className="v2-section">Recently changed</h3>
      {view.changed.map((e) => (
        <EntityCard key={e.id} e={e} actions={actions} />
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Auth + team gates
// ----------------------------------------------------------------------------
function AuthGate({
  supabase,
}: {
  supabase: NonNullable<ReturnType<typeof createSupabaseBrowserClient>>;
}) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name } },
        });
        if (error) throw error;
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setErr(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    // on success the browser redirects to Google; onAuthStateChange handles the return
    if (error) setErr(error.message);
  }

  return (
    <div className="centered">
      <form className="v2-auth" onSubmit={submit}>
        <h1>Lattice</h1>
        <p className="v2-sub">Tell it what’s happening; it tracks who owes what and what’s slipping.</p>

        <button type="button" className="v2-google" onClick={google}>
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.9 6.1C12.2 13.2 17.6 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-17z" />
            <path fill="#FBBC05" d="M10.4 28.3c-.5-1.4-.8-2.9-.8-4.3s.3-3 .8-4.3l-7.9-6.1C.9 16.8 0 20.3 0 24s.9 7.2 2.5 10.4l7.9-6.1z" />
            <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.1-5.5c-2 1.3-4.6 2.1-7.9 2.1-6.4 0-11.8-3.7-13.6-9.8l-7.9 6.1C6.4 42.6 14.6 48 24 48z" />
          </svg>
          Continue with Google
        </button>
        <div className="v2-divider">or</div>

        {mode === "up" && (
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {err && <div className="v2-error">{err}</div>}
        <button className="v2-primary" disabled={busy} type="submit">
          {mode === "in" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="v2-link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

function TeamGate({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="centered">
      <form
        className="v2-auth"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <h1>Name your team</h1>
        <p className="v2-sub">One small team. You can invite people after.</p>
        <input placeholder="e.g. Demo crew" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="v2-primary" type="submit">
          Create
        </button>
      </form>
    </div>
  );
}
