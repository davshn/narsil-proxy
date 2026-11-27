-- Shared task lists for Narsil. Membership is by confirmed email: the owner invites an email,
-- and that person sees the invitation once signed in and joins only by accepting it. Every
-- permission lives in the row level security policies below; the app only follows them.

-- ---------- Profiles: the name and email others see ----------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email = lower(email)),
  name text not null default '' check (char_length(name) <= 200),
  created_at timestamptz not null default now()
);

-- A profile exists only for a confirmed email, so an unconfirmed sign-up cannot pose as an
-- invited person or show a made-up name to a list. When the account email changes, the
-- profile, the memberships and the tasks assigned to that email all move to the new one, so
-- the person keeps their lists and nobody who later signs up with the old email inherits them.
-- Membership relies on Supabase Auth confirming every new email: keep "Confirm email" and
-- "Secure email change" on.
create function public.sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_email text;
  new_email text := lower(new.email);
begin
  if new.email_confirmed_at is null or new.email is null then
    return new;
  end if;
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new_email,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 200)
  )
  on conflict (id) do update set email = excluded.email;

  if tg_op = 'UPDATE' and old.email is not null and lower(old.email) <> new_email then
    old_email := lower(old.email);
    -- Where the new email is already in the list, its row stays: hand it the tasks, drop the old row.
    update public.shared_tasks t set assignee_email = new_email
    where t.assignee_email = old_email
      and exists (select 1 from public.list_members m where m.list_id = t.list_id and m.email = new_email);
    delete from public.list_members m
    where m.email = old_email
      and exists (select 1 from public.list_members n where n.list_id = m.list_id and n.email = new_email);
    -- Everywhere else the row moves, and its assigned tasks follow through the cascading key.
    update public.list_members set email = new_email where email = old_email;
  end if;
  return new;
end;
$$;

create trigger profile_on_signup after insert on auth.users
  for each row execute function public.sync_profile();
create trigger profile_on_confirm after update of email_confirmed_at, email on auth.users
  for each row execute function public.sync_profile();

-- ---------- Lists, members and tasks ----------

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  -- One column, so a list has exactly one owner.
  owner_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.list_members (
  list_id uuid not null references public.lists (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email like '%_@_%' and char_length(email) <= 320),
  added_at timestamptz not null default now(),
  -- Null while the invitation waits; the invited person sets it by accepting.
  accepted_at timestamptz,
  primary key (list_id, email)
);

create table public.shared_tasks (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 5000),
  status text not null default 'todo' check (status in ('todo', 'started', 'in-progress', 'paused', 'done')),
  assignee_email text,
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  -- A task is assigned only to a member. Removing that member deletes the tasks assigned to them,
  -- and when the member's email changes the tasks follow it.
  foreign key (list_id, assignee_email) references public.list_members (list_id, email)
    on delete cascade on update cascade
);

create index shared_tasks_list_idx on public.shared_tasks (list_id);
create index list_members_email_idx on public.list_members (email);

-- ---------- Who is asking ----------

-- The signed-in user's email, only when it is confirmed.
create function public.current_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = auth.uid() and email_confirmed_at is not null
$$;

-- A member is someone who accepted. An invited person has a row that still waits.
create function public.is_member(list uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.list_members m
    where m.list_id = list and m.email = public.current_email() and m.accepted_at is not null
  )
$$;

create function public.is_invited(list uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.list_members m
    where m.list_id = list and m.email = public.current_email() and m.accepted_at is null
  )
$$;

-- Whether someone accepted, answered only to members of that list, so nobody can probe a
-- list's members by guessing emails.
create function public.is_accepted(list uuid, member_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_member(list) and exists (
    select 1 from public.list_members m
    where m.list_id = list and m.email = member_email and m.accepted_at is not null
  )
$$;

create function public.is_owner(list uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lists l where l.id = list and l.owner_id = auth.uid())
$$;

-- Whose profile I may see: members of a list we both accepted, and whoever owns a list I am
-- invited to. Someone invited is not seen until they accept.
create function public.shares_list_with(other_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.list_members mine
    join public.list_members theirs on theirs.list_id = mine.list_id
    where mine.email = public.current_email() and mine.accepted_at is not null
      and theirs.email = other_email and theirs.accepted_at is not null
  ) or exists (
    select 1
    from public.list_members mine
    join public.lists l on l.id = mine.list_id
    join public.profiles owner on owner.id = l.owner_id
    where mine.email = public.current_email() and mine.accepted_at is null and owner.email = other_email
  )
$$;

-- ---------- Rules the policies cannot express ----------

-- A new row is an invitation waiting for an answer, except the owner's own, which counts as
-- accepted. Accepting always records the real time. Users can only update accepted_at, so an
-- update that changes the email is the account email moving (see sync_profile): it keeps the
-- row's answer as it was.
create function public.normalize_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.email := lower(btrim(new.email));
    new.added_at := now();
    new.accepted_at := case
      when exists (
        select 1 from public.lists l join public.profiles p on p.id = l.owner_id
        where l.id = new.list_id and p.email = new.email
      ) then now()
    end;
  elsif new.email = old.email then
    new.accepted_at := coalesce(old.accepted_at, now());
  else
    new.accepted_at := old.accepted_at;
  end if;
  return new;
end;
$$;

create trigger member_normalized before insert or update on public.list_members
  for each row execute function public.normalize_member();

create function public.add_owner_as_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.list_members (list_id, email)
  select new.id, p.email from public.profiles p where p.id = new.owner_id;
  return new;
end;
$$;

create trigger owner_joins_list after insert on public.lists
  for each row execute function public.add_owner_as_member();

-- The owner stays a member while the list exists; deleting the list removes everyone.
create function public.keep_owner_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.lists l join public.profiles p on p.id = l.owner_id
    where l.id = old.list_id and p.email = old.email
  ) then
    raise exception 'El dueño no puede salir de su propia lista.';
  end if;
  return old;
end;
$$;

create trigger owner_stays_member before delete on public.list_members
  for each row execute function public.keep_owner_member();

-- Who changed a task last, and when, always comes from the session and the clock, never from
-- the values sent. A task keeps its id, creator and list for life.
create function public.stamp_task_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.list_id <> old.list_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
      raise exception 'Una tarea no cambia de id, creador ni lista.';
    end if;
  else
    new.created_at := now();
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger task_change_stamped before insert or update on public.shared_tasks
  for each row execute function public.stamp_task_change();

-- ---------- Row level security ----------

alter table public.profiles enable row level security;
alter table public.lists enable row level security;
alter table public.list_members enable row level security;
alter table public.shared_tasks enable row level security;

-- Nothing here is for signed-out callers. Postgres lets everyone run a new function, so the
-- helpers are taken from public as well as anon and given back to signed-in users only.
revoke all on public.profiles, public.lists, public.list_members, public.shared_tasks from anon;
revoke execute on function public.current_email(), public.is_member(uuid), public.is_invited(uuid),
  public.is_accepted(uuid, text), public.is_owner(uuid), public.shares_list_with(text)
  from public, anon;
grant execute on function public.current_email(), public.is_member(uuid), public.is_invited(uuid),
  public.is_accepted(uuid, text), public.is_owner(uuid), public.shares_list_with(text)
  to authenticated;
-- Truncate skips row level security; trigger and references are never needed by the app.
revoke truncate, trigger, references on public.profiles, public.lists, public.list_members, public.shared_tasks
  from authenticated;
-- A profile's email and id come from the sign-in; only the name is the user's to change.
revoke insert, update, delete on public.profiles from authenticated;
grant update (name) on public.profiles to authenticated;
-- An invitation names a list and an email; answering it only sets the acceptance time.
revoke insert, update on public.list_members from authenticated;
grant insert (list_id, email) on public.list_members to authenticated;
grant update (accepted_at) on public.list_members to authenticated;

create policy "see own profile and the people sharing a list" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or public.shares_list_with(email));
create policy "change own name" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- The owner also sees a list she just created, before her membership row exists. An invited
-- person sees the list too, to know what they are asked to join.
create policy "members and invited people see the list" on public.lists
  for select to authenticated using (owner_id = (select auth.uid()) or public.is_member(id) or public.is_invited(id));
create policy "create own lists" on public.lists
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "the owner renames, and the owner never changes" on public.lists
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "the owner deletes" on public.lists
  for delete to authenticated using (owner_id = (select auth.uid()));

create policy "members see the members, and each person their own invitation" on public.list_members
  for select to authenticated using (public.is_member(list_id) or email = (select public.current_email()));
create policy "the owner invites" on public.list_members
  for insert to authenticated with check (public.is_owner(list_id));
create policy "the invited person accepts" on public.list_members
  for update to authenticated
  using (email = (select public.current_email()) and accepted_at is null)
  with check (email = (select public.current_email()));
-- Leaving or declining deletes your own row; the owner's is protected by owner_stays_member.
create policy "the owner removes, and anyone leaves" on public.list_members
  for delete to authenticated using (public.is_owner(list_id) or email = (select public.current_email()));

create policy "members see the tasks" on public.shared_tasks
  for select to authenticated using (public.is_member(list_id));
create policy "members create tasks in their own name, for members who accepted" on public.shared_tasks
  for insert to authenticated
  with check (
    public.is_member(list_id) and created_by = (select auth.uid())
    and (assignee_email is null or public.is_accepted(list_id, assignee_email))
  );
create policy "the assignee and the creator change a task" on public.shared_tasks
  for update to authenticated
  using (public.is_member(list_id) and (created_by = (select auth.uid()) or assignee_email = (select public.current_email())))
  with check (public.is_member(list_id) and (assignee_email is null or public.is_accepted(list_id, assignee_email)));
-- Membership is checked here too: a filter that reads no column skips the select policy.
create policy "the creator and the owner delete a task" on public.shared_tasks
  for delete to authenticated
  using (public.is_member(list_id) and (created_by = (select auth.uid()) or public.is_owner(list_id)));
