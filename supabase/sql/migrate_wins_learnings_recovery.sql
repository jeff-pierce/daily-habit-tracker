-- Recover legacy Wins/Learnings entries after moving to default habit IDs.
--
-- What this does:
-- 1) Finds each user's legacy Wins/Learnings custom habit IDs (if any).
-- 2) Copies old values from dht_logs.values[legacy_id] into values['wins'] / values['learnings']
--    only when the new key is currently missing or blank.
-- 3) Optionally hides old legacy habits so users don't see duplicate fields.
--
-- Safe to run multiple times.

begin;

-- Optional: Inspect candidates before migration.
-- select user_id, id, name, visible, sort_order
-- from public.dht_habits
-- where lower(name) in ('wins', 'learnings')
-- order by user_id, lower(name), sort_order nulls last, id;

do $$
declare
  u record;
  legacy_wins_id text;
  legacy_learnings_id text;
begin
  for u in
    select distinct user_id
    from public.dht_habits
  loop
    -- Legacy Wins habit (non-default ID)
    select h.id
      into legacy_wins_id
    from public.dht_habits h
    where h.user_id = u.user_id
      and lower(h.name) = 'wins'
      and h.id <> 'wins'
    order by h.sort_order desc nulls last, h.id desc
    limit 1;

    if legacy_wins_id is not null then
      update public.dht_logs l
      set values = jsonb_set(l.values, '{wins}', l.values -> legacy_wins_id, true),
          updated_at = timezone('utc', now())
      where l.user_id = u.user_id
        and l.values ? legacy_wins_id
        and (
          not (l.values ? 'wins')
          or nullif(trim(coalesce(l.values ->> 'wins', '')), '') is null
        );
    end if;

    -- Legacy Learnings habit (non-default ID)
    select h.id
      into legacy_learnings_id
    from public.dht_habits h
    where h.user_id = u.user_id
      and lower(h.name) = 'learnings'
      and h.id <> 'learnings'
    order by h.sort_order desc nulls last, h.id desc
    limit 1;

    if legacy_learnings_id is not null then
      update public.dht_logs l
      set values = jsonb_set(l.values, '{learnings}', l.values -> legacy_learnings_id, true),
          updated_at = timezone('utc', now())
      where l.user_id = u.user_id
        and l.values ? legacy_learnings_id
        and (
          not (l.values ? 'learnings')
          or nullif(trim(coalesce(l.values ->> 'learnings', '')), '') is null
        );
    end if;
  end loop;
end;
$$;

-- Optional: hide legacy custom habits so users only see the default fields.
update public.dht_habits
set visible = false
where lower(name) in ('wins', 'learnings')
  and id not in ('wins', 'learnings')
  and coalesce(visible, true) = true;

commit;

-- Optional: verify for one user (replace UUID) 
-- select log_date, values ->> 'wins' as wins, values ->> 'learnings' as learnings
-- from public.dht_logs
-- where user_id = '00000000-0000-0000-0000-000000000000'
-- order by log_date desc
-- limit 30;
