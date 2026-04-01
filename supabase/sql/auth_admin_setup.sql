-- Daily Habit Tracker auth, roles, invites, and preferences
-- Run this in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.dht_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'user' check (role in ('user', 'admin')),
  disabled boolean not null default false,
  last_sign_in_at timestamptz,
  weekly_summary_enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.dht_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  invited_by uuid not null references auth.users(id) on delete restrict,
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invite_token uuid not null default gen_random_uuid(),
  resend_count integer not null default 0,
  last_sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.dht_email_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  job_type text not null check (job_type in ('weekly_summary')),
  job_status text not null default 'pending' check (job_status in ('pending', 'processing', 'sent', 'failed')),
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.dht_logs
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create or replace function public.dht_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.dht_is_admin(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dht_profiles
    where user_id = check_user_id
      and role = 'admin'
  );
$$;

create or replace function public.dht_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_record public.dht_invites%rowtype;
  normalized_email text;
begin
  normalized_email := lower(new.email);

  select *
  into invite_record
  from public.dht_invites
  where email = normalized_email
    and status = 'pending'
  order by created_at desc
  limit 1;

  insert into public.dht_profiles (user_id, email, role)
  values (
    new.id,
    normalized_email,
    case
      when normalized_email = 'jeffpierce@gmail.com' then 'admin'
      when invite_record.id is not null and invite_record.role = 'admin' then 'admin'
      else 'user'
    end
  )
  on conflict (user_id) do update
  set email = excluded.email,
      role = excluded.role,
      updated_at = timezone('utc', now());

  if invite_record.id is not null then
    update public.dht_invites
    set status = 'accepted',
        accepted_at = timezone('utc', now()),
        updated_at = timezone('utc', now())
    where id = invite_record.id;
  end if;

  return new;
end;
$$;

drop trigger if exists dht_on_auth_user_created on auth.users;
create trigger dht_on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.dht_handle_new_user();

drop trigger if exists dht_profiles_set_updated_at on public.dht_profiles;
create trigger dht_profiles_set_updated_at
  before update on public.dht_profiles
  for each row execute procedure public.dht_set_updated_at();

drop trigger if exists dht_invites_set_updated_at on public.dht_invites;
create trigger dht_invites_set_updated_at
  before update on public.dht_invites
  for each row execute procedure public.dht_set_updated_at();

drop trigger if exists dht_email_jobs_set_updated_at on public.dht_email_jobs;
create trigger dht_email_jobs_set_updated_at
  before update on public.dht_email_jobs
  for each row execute procedure public.dht_set_updated_at();

alter table public.dht_profiles enable row level security;
alter table public.dht_invites enable row level security;
alter table public.dht_email_jobs enable row level security;

drop policy if exists "profiles_select_self_or_admin" on public.dht_profiles;
create policy "profiles_select_self_or_admin"
on public.dht_profiles
for select
using (auth.uid() = user_id or public.dht_is_admin());

drop policy if exists "profiles_update_self_or_admin" on public.dht_profiles;
create policy "profiles_update_self_or_admin"
on public.dht_profiles
for update
using (auth.uid() = user_id or public.dht_is_admin())
with check (auth.uid() = user_id or public.dht_is_admin());

drop policy if exists "profiles_insert_self" on public.dht_profiles;
create policy "profiles_insert_self"
on public.dht_profiles
for insert
with check (auth.uid() = user_id or public.dht_is_admin());

drop policy if exists "invites_admin_only_select" on public.dht_invites;
create policy "invites_admin_only_select"
on public.dht_invites
for select
using (public.dht_is_admin());

drop policy if exists "invites_admin_only_insert" on public.dht_invites;
create policy "invites_admin_only_insert"
on public.dht_invites
for insert
with check (public.dht_is_admin());

drop policy if exists "invites_admin_only_update" on public.dht_invites;
create policy "invites_admin_only_update"
on public.dht_invites
for update
using (public.dht_is_admin())
with check (public.dht_is_admin());

drop policy if exists "email_jobs_admin_or_self_select" on public.dht_email_jobs;
create policy "email_jobs_admin_or_self_select"
on public.dht_email_jobs
for select
using (public.dht_is_admin() or auth.uid() = user_id);

drop policy if exists "email_jobs_admin_insert" on public.dht_email_jobs;
create policy "email_jobs_admin_insert"
on public.dht_email_jobs
for insert
with check (public.dht_is_admin());

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
  p.weekly_summary_enabled,
  coalesce(a.active_days_last_30, 0) as active_days_last_30,
  coalesce(cs.streak_days, 0) as streak_days,
  p.created_at,
  p.updated_at
from public.dht_profiles p
left join active_days a on a.user_id = p.user_id
left join current_streak cs on cs.user_id = p.user_id;

grant select on public.dht_admin_user_metrics to authenticated;

drop policy if exists "logs_select_own" on public.dht_logs;
create policy "logs_select_own"
on public.dht_logs
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

-- Trigger: keep last_sign_in_at in dht_profiles in sync when a user signs in.
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
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "habits_select_own" on public.dht_habits;
create policy "habits_select_own"
on public.dht_habits
for select
using (auth.uid() = user_id);

drop policy if exists "habits_insert_own" on public.dht_habits;
create policy "habits_insert_own"
on public.dht_habits
for insert
with check (auth.uid() = user_id);

drop policy if exists "habits_update_own" on public.dht_habits;
create policy "habits_update_own"
on public.dht_habits
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into public.dht_profiles (user_id, email, role)
select id, lower(email), 'admin'
from auth.users
where lower(email) = 'jeffpierce@gmail.com'
on conflict (user_id) do update
set role = 'admin',
    email = excluded.email,
    updated_at = timezone('utc', now());
