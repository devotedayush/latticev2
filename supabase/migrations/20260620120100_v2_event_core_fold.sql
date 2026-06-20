-- ============================================================
-- Lattice V2 — event-sourced core: fold logic
-- ============================================================

-- per-team monotonic seq
create or replace function public.lattice_assign_event_seq()
returns trigger language plpgsql as $$
begin
  if new.seq is null or new.seq = 0 then
    perform pg_advisory_xact_lock(hashtext('lattice_seq_'||new.team_space_id));
    select coalesce(max(seq),0)+1 into new.seq from public.events where team_space_id = new.team_space_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_events_seq on public.events;
create trigger trg_events_seq before insert on public.events
  for each row execute function public.lattice_assign_event_seq();

-- fold: recompute one entity's snapshot row from its active events
create or replace function public.lattice_fold_entity(p_team text, p_entity text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ev record;
  st jsonb := '{}'::jsonb;
  setters jsonb := '{}'::jsonb;
  conflict jsonb := null;
  k text;
  v jsonb;
  prev jsonb;
  e_type orgmind_object_type := null;
  first_ts timestamptz := null;
  last_ts timestamptz := null;
  last_seq bigint := 0;
  n_active int := 0;
begin
  for ev in
    select * from public.events e
    where e.team_space_id = p_team
      and e.entity_id = p_entity
      and e.kind <> 'retraction'
      and e.retracted_at is null
      and not exists (select 1 from public.events r where r.kind = 'retraction' and r.supersedes = e.id)
    order by e.seq asc
  loop
    n_active := n_active + 1;
    if first_ts is null then first_ts := ev.created_at; end if;
    last_ts := ev.created_at;
    last_seq := ev.seq;
    if ev.entity_type is not null then e_type := ev.entity_type; end if;

    if ev.after is not null then
      for k, v in select * from jsonb_each(ev.after)
      loop
        if k in ('due_at','status','owner') then
          prev := setters -> k;
          if prev is not null
             and (prev->'value') is distinct from v
             and (prev->>'actor') is distinct from ev.actor_name
             and ev.created_at - (prev->>'ts')::timestamptz < interval '48 hours' then
            conflict := jsonb_build_object(
              'field', k,
              'claims', jsonb_build_array(
                jsonb_build_object('actor', prev->>'actor', 'value', prev->'value', 'at', prev->>'ts'),
                jsonb_build_object('actor', ev.actor_name, 'value', v, 'at', ev.created_at)
              )
            );
          end if;
          setters := setters || jsonb_build_object(k, jsonb_build_object('actor', ev.actor_name, 'value', v, 'ts', ev.created_at));
        end if;
        st := st || jsonb_build_object(k, v);
      end loop;
    end if;

    if ev.confidence is not null then
      st := st || jsonb_build_object('confidence', to_jsonb(ev.confidence));
    end if;
  end loop;

  if n_active = 0 then
    delete from public.entities where id = p_entity and team_space_id = p_team;
    return;
  end if;

  insert into public.entities as en (
    id, team_space_id, type, title, detail, owner, status, confidence, pulse, links,
    due_at, deferred_until, decline_reason, conflict, last_event_seq, created_at, updated_at
  ) values (
    p_entity, p_team, coalesce(e_type,'signal'),
    coalesce(st->>'title',''),
    coalesce(st->>'detail',''),
    nullif(st->>'owner',''),
    st->>'status',
    coalesce((st->>'confidence')::numeric, 0.7),
    coalesce(st->>'pulse','quiet'),
    coalesce((select array_agg(x) from jsonb_array_elements_text(
      case when jsonb_typeof(st->'links')='array' then st->'links' else '[]'::jsonb end) x), '{}'),
    (st->>'due_at')::timestamptz,
    (st->>'deferred_until')::timestamptz,
    st->>'decline_reason',
    conflict,
    last_seq, coalesce(first_ts, now()), coalesce(last_ts, now())
  )
  on conflict (id) do update set
    type=excluded.type, title=excluded.title, detail=excluded.detail, owner=excluded.owner,
    status=excluded.status, confidence=excluded.confidence, pulse=excluded.pulse, links=excluded.links,
    due_at=excluded.due_at, deferred_until=excluded.deferred_until, decline_reason=excluded.decline_reason,
    conflict=excluded.conflict, last_event_seq=excluded.last_event_seq, updated_at=excluded.updated_at;
end $$;

-- after an event lands, re-fold the affected entity (and the retraction target)
create or replace function public.lattice_after_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare target_entity text;
begin
  if new.entity_id is not null then
    perform public.lattice_fold_entity(new.team_space_id, new.entity_id);
  end if;
  if new.kind = 'retraction' and new.supersedes is not null then
    select entity_id into target_entity from public.events where id = new.supersedes;
    if target_entity is not null and target_entity is distinct from new.entity_id then
      perform public.lattice_fold_entity(new.team_space_id, target_entity);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_events_fold on public.events;
create trigger trg_events_fold after insert or update on public.events
  for each row execute function public.lattice_after_event();
