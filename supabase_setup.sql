create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tasks (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  owner_email text,
  text text not null default '',
  category text not null default 'work',
  done boolean not null default false,
  blocked boolean not null default false,
  priority text not null default 'medium',
  scheduled_date text,
  notes text not null default '',
  created_at bigint not null,
  completed_at bigint,
  updated_at bigint not null,
  tag text,
  sort_order bigint,
  archived_at bigint,
  archived_date text,
  deleted_at bigint
);

create table if not exists public.notification_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default true,
  morning_enabled boolean not null default true,
  morning_time text not null default '08:00',
  evening_enabled boolean not null default true,
  evening_time text not null default '20:00',
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_updated_at_idx on public.tasks (updated_at desc);
create index if not exists tasks_archived_at_idx on public.tasks (archived_at desc);
create index if not exists notification_settings_updated_at_idx on public.notification_settings (updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, is_admin)
  values (new.id, new.email, coalesce(lower(new.email), '') = 'rbyogena@gmail.com')
  on conflict (id) do update
  set email = excluded.email,
      is_admin = excluded.is_admin,
      updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

insert into public.profiles (id, email, is_admin)
select id, email, coalesce(lower(email), '') = 'rbyogena@gmail.com'
from auth.users
on conflict (id) do update
set email = excluded.email,
    is_admin = excluded.is_admin,
    updated_at = timezone('utc', now());

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_admin = true
  );
$$;

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.notification_settings enable row level security;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
on public.profiles
for select
using (id = auth.uid() or public.is_admin_user());

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
on public.profiles
for update
using (id = auth.uid() or public.is_admin_user())
with check (id = auth.uid() or public.is_admin_user());

drop policy if exists "tasks_select_own_or_admin" on public.tasks;
create policy "tasks_select_own_or_admin"
on public.tasks
for select
using (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "tasks_insert_own_or_admin" on public.tasks;
create policy "tasks_insert_own_or_admin"
on public.tasks
for insert
with check (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "tasks_update_own_or_admin" on public.tasks;
create policy "tasks_update_own_or_admin"
on public.tasks
for update
using (user_id = auth.uid() or public.is_admin_user())
with check (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "tasks_delete_own_or_admin" on public.tasks;
create policy "tasks_delete_own_or_admin"
on public.tasks
for delete
using (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "notification_settings_select_self_or_admin" on public.notification_settings;
create policy "notification_settings_select_self_or_admin"
on public.notification_settings
for select
using (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "notification_settings_insert_self_or_admin" on public.notification_settings;
create policy "notification_settings_insert_self_or_admin"
on public.notification_settings
for insert
with check (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "notification_settings_update_self_or_admin" on public.notification_settings;
create policy "notification_settings_update_self_or_admin"
on public.notification_settings
for update
using (user_id = auth.uid() or public.is_admin_user())
with check (user_id = auth.uid() or public.is_admin_user());

drop policy if exists "notification_settings_delete_self_or_admin" on public.notification_settings;
create policy "notification_settings_delete_self_or_admin"
on public.notification_settings
for delete
using (user_id = auth.uid() or public.is_admin_user());

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    execute 'alter publication supabase_realtime add table public.tasks';
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notification_settings'
  ) then
    execute 'alter publication supabase_realtime add table public.notification_settings';
  end if;
end
$$;
