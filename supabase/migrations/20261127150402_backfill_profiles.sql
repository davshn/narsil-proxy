-- Accounts that signed in before the shared lists schema existed never ran the profile trigger,
-- so they have no profile and cannot own a list. Give each confirmed account its profile, the
-- same way sync_profile does on sign-up. Safe to run again: existing profiles are left alone.
insert into public.profiles (id, email, name)
select
  u.id,
  lower(u.email),
  left(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''), 200)
from auth.users u
where u.email_confirmed_at is not null and u.email is not null
on conflict do nothing;
