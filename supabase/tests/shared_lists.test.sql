begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- How many rows a statement touched, as the role running it. Row level security turns a
-- forbidden update or delete into zero rows, not an error.
create function pg_temp.affected(statement text) returns int language plpgsql as $f$
declare n int;
begin
  execute statement;
  get diagnostics n = row_count;
  return n;
end;
$f$;

-- People. Ana owns the list, Beto is a member, Carla is invited before she signs up,
-- Dani is an outsider, Eve is invited but never confirmed her email.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'Ana@Example.com', now(), '{"full_name":"Ana Ruiz"}', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'beto@example.com', now(), '{"full_name":"Beto Paz"}', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'dani@example.com', now(), '{"full_name":"Dani Sol"}', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'eve@example.com', null, '{"full_name":"Eve"}', 'authenticated', 'authenticated');

select is((select name from public.profiles where id = '11111111-1111-1111-1111-111111111111'), 'Ana Ruiz',
  'signing up creates a profile with the Google name');
select is((select email from public.profiles where id = '11111111-1111-1111-1111-111111111111'), 'ana@example.com',
  'the profile email is lowercase');

-- ---------- Ana creates a list ----------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok(
  $$insert into public.lists (id, name, owner_id) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Equipo Tenzor', '11111111-1111-1111-1111-111111111111')$$,
  'a user creates a list she owns');
select results_eq($$select email from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  $$values ('ana@example.com')$$, 'the owner becomes a member of her own list');
select throws_ok(
  $$insert into public.lists (name, owner_id) values ('Ajena', '22222222-2222-2222-2222-222222222222')$$,
  '42501', null, 'nobody creates a list owned by someone else');

select lives_ok(
  $$insert into public.list_members (list_id, email) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'Beto@Example.com '),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'carla@example.com'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'eve@example.com')$$,
  'the owner invites by email, trimmed and lowercased');
select results_eq(
  $$select email from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by email$$,
  $$values ('ana@example.com'), ('beto@example.com'), ('carla@example.com'), ('eve@example.com')$$,
  'the list has the owner and the three invitations');

select lives_ok(
  $$insert into public.shared_tasks (id, list_id, name, assignee_email) values
    ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Revisar contrato', 'beto@example.com'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Llamar al cliente', 'carla@example.com')$$,
  'a member creates tasks assigned to members');
select is((select created_by from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'the creator is the signed-in user');
select throws_ok(
  $$insert into public.shared_tasks (list_id, name, assignee_email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X', 'dani@example.com')$$,
  '23503', null, 'a task cannot be assigned to someone outside the list');
select throws_ok(
  $$insert into public.shared_tasks (list_id, name, created_by) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X', '22222222-2222-2222-2222-222222222222')$$,
  '42501', null, 'nobody creates a task in someone else''s name');

-- ---------- Beto, a member ----------
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select results_eq($$select name from public.lists$$, $$values ('Equipo Tenzor')$$, 'a member sees the list');
select is((select count(*)::int from public.shared_tasks), 2, 'a member sees every task of the list');
select is((select count(*)::int from public.profiles), 2,
  'a member sees the profiles of the people sharing a list with him, and his own');

select is(
  pg_temp.affected($$update public.shared_tasks set status = 'in-progress', name = 'Revisar el contrato', description = 'Cláusula 4' where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$),
  1, 'the assignee changes the status, name and description');
select is((select updated_by from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  '22222222-2222-2222-2222-222222222222'::uuid, 'a change records who made it');
select is(
  pg_temp.affected($$update public.shared_tasks set status = 'done' where id = 'bbbbbbbb-0000-0000-0000-000000000002'$$),
  0, 'a member who is neither the assignee nor the creator cannot change a task');
select throws_ok(
  $$update public.shared_tasks set created_by = '22222222-2222-2222-2222-222222222222' where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  'P0001', 'El creador y la lista de una tarea no cambian.', 'the creator of a task never changes');
select throws_ok(
  $$update public.shared_tasks set status = 'lista' where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  '23514', null, 'the status is one of the five Pendientes statuses');

select is(
  pg_temp.affected($$delete from public.list_members where email = 'carla@example.com'$$),
  0, 'a member who is not the owner cannot remove anyone');
select throws_ok(
  $$insert into public.list_members (list_id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'dani@example.com')$$,
  '42501', null, 'a member who is not the owner cannot invite');
select is(
  pg_temp.affected($$update public.lists set name = 'Mía'$$),
  0, 'a member who is not the owner cannot rename the list');
select is(
  pg_temp.affected($$delete from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000002'$$),
  0, 'a member cannot delete a task he did not create');

-- ---------- Dani, an outsider ----------
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';

select is_empty($$select 1 from public.lists$$, 'an outsider sees no list');
select is_empty($$select 1 from public.shared_tasks$$, 'an outsider sees no task');
select is_empty($$select 1 from public.list_members$$, 'an outsider sees no member');
select is((select count(*)::int from public.profiles), 1, 'an outsider sees only his own profile');
select throws_ok(
  $$insert into public.list_members (list_id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'dani@example.com')$$,
  '42501', null, 'an outsider cannot add himself to a list');

-- ---------- Eve, invited but never confirmed ----------
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';

select is_empty($$select 1 from public.lists$$, 'an unconfirmed email does not open an invitation');

-- ---------- Nobody signed in ----------
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select 1 from public.lists$$, '42501', null, 'the anonymous role reads nothing');

-- ---------- Carla signs up after being invited ----------
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
  ('33333333-3333-3333-3333-333333333333', 'carla@example.com', now(), '{"name":"Carla"}', 'authenticated', 'authenticated');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select results_eq($$select name from public.lists$$, $$values ('Equipo Tenzor')$$,
  'an invitation opens the list as soon as the invited person signs in');
select is(
  pg_temp.affected($$update public.shared_tasks set assignee_email = 'beto@example.com' where id = 'bbbbbbbb-0000-0000-0000-000000000002'$$),
  1, 'the assignee can hand a task to another member');
select lives_ok(
  $$insert into public.shared_tasks (id, list_id, name, assignee_email) values
    ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Tarea de Carla', 'carla@example.com'),
    ('bbbbbbbb-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Encargo de Carla para Beto', 'beto@example.com')$$,
  'Carla creates one task for herself and one for Beto');

-- ---------- Ana removes Carla ----------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok($$delete from public.list_members where email = 'ana@example.com'$$,
  'P0001', 'El dueño no puede salir de su propia lista.', 'the owner cannot remove herself');
select throws_ok($$update public.lists set owner_id = '22222222-2222-2222-2222-222222222222'$$,
  '42501', null, 'a list keeps its one owner');
select lives_ok($$delete from public.list_members where email = 'carla@example.com'$$, 'the owner removes a member');
select is_empty($$select 1 from public.shared_tasks where assignee_email = 'carla@example.com'$$,
  'removing a member deletes the tasks assigned to her');
select results_eq($$select name from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000004'$$,
  $$values ('Encargo de Carla para Beto')$$, 'tasks she created for others stay');
select lives_ok($$delete from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000004'$$,
  'the owner deletes any task of her list');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is_empty($$select 1 from public.lists$$, 'a removed member no longer sees the list');

-- ---------- Ana deletes the list ----------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$delete from public.lists where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'the owner deletes her list');
reset role;
select is_empty($$select 1 from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'deleting a list deletes its members');
select is_empty($$select 1 from public.shared_tasks where list_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'deleting a list deletes its tasks');

select * from finish();
rollback;
