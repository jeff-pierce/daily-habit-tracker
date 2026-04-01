-- Admin user management: disable/enable users, track last sign-in.
-- Run after auth_admin_setup.sql (existing setup must already be in place).
-- Safe to run multiple times.

-- 1. Add disabled flag and last_sign_in_at to dht_profiles.
alter table public.dht_profiles
  add column if not exists disabled boolean not null default false,
  add column if not exists last_sign_in_at timestamptz;

-- 2. Backfill last_sign_in_at from auth.users for existing accounts.
update public.dht_profiles p
set last_sign_in_at = au.last_sign_in_at
from auth.users au
where au.id = p.user_id
  and p.last_sign_in_at is null;

-- 3. Trigger: keep last_sign_in_at in dht_profiles in sync when a user signs in.
create or replace function public.dht_handle_user_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.dht_profiles
    set last_sign_in_at = new.last_sign_in_at,
        updated_at = timezone('utc', now())
    where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists dht_on_auth_user_login on auth.users;
create trigger dht_on_auth_user_login
  after update on auth.users
  for each row execute procedure public.dht_handle_user_login();

-- 4. Replace dht_admin_user_metrics view to expose disabled and last_sign_in_at.
create or replace view public.dht_admin_user_metrics as
with daily_activity as (
  select
    l.user_id,
    l.log_date,
    case
      when exists (
        select 1
        from public.dht_habits h
        where h.user_id = l.user_id
          and coalesce(h.visible, true) = true
          and (
            (h.type = 'toggle' and coalesce((l.values ->> h.id)::boolean, false) = true)
            or (h.type = 'counter' and coalesce((l.values ->> h.id)::numeric, 0) > 0)
            or (h.type = 'slider' and coalesce((l.values ->> h.id)::numeric, 0) > 0)
            or (h.type = 'mood' and coalesce((l.values ->> h.id)::numeric, 0) > 0)
            or (h.type = 'text' and coalesce(nullif(l.values ->> h.id, ''), '') <> '')
            or (h.type = 'gratitude' and jsonb_typeof(l.values -> h.id) = 'array' and jsonb_array_length(l.values -> h.id) > 0)
          )
      ) then true
      else false
    end as is_active
  from public.dht_logs l
),
active_days as (
  select
    user_id,
    count(*) filter (where is_active and log_date >= current_date - interval '29 days')::int as active_days_last_30
  from daily_activity
  group by user_id
),
ordered_days as (
  select user_id, log_date
  from daily_activity
  where is_active
),
streak_groups as (
  select
    user_id,
    log_date,
    log_date - (row_number() over (partition by user_id order by log_date desc))::int as grp
  from ordered_days
  where log_date <= current_date
),
current_streak as (
  select
    user_id,
    count(*)::int as streak_days
  from streak_groups
  where grp = (
    select grp
    from streak_groups sg2
    where sg2.user_id = streak_groups.user_id
    order by log_date desc
    limit 1
  )
  and exists (
    select 1
    from ordered_days od
    where od.user_id = streak_groups.user_id
      and od.log_date in (current_date, current_date - interval '1 day')
  )
  group by user_id
)
select
  p.user_id,
  p.email,
  p.role,
  p.disabled,
  p.last_sign_in_at,
  p.weekly_summary_enabled,
  coalesce(a.active_days_last_30, 0) as active_days_last_30,
  coalesce(cs.streak_days, 0) as streak_days,
  p.created_at,
  p.updated_at
from public.dht_profiles p
left join active_days a on a.user_id = p.user_id
left join current_streak cs on cs.user_id = p.user_id;

grant select on public.dht_admin_user_metrics to authenticated;
