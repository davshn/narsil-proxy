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

-- People. Ana owns the list, Beto and Carla are invited (Carla before she signs up), Dani is an
-- outsider, Eve is invited but never confirmed her email.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'Ana@Example.com', now(), '{"full_name":"Ana Ruiz"}', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'beto@example.com', now(), '{"full_name":"Beto Paz"}', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'dani@example.com', now(), '{"full_name":"Dani Sol"}', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'eve@example.com', null, '{"full_name":"Eve"}', 'authenticated', 'authenticated');

select is((select name from public.profiles where id = '11111111-1111-1111-1111-111111111111'), 'Ana Ruiz',
  'signing up creates a profile with the Google name');
select is((select email from public.profiles where id = '11111111-1111-1111-1111-111111111111'), 'ana@example.com',
  'the profile email is lowercase');

-- ---------- Ana creates a list and invites ----------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select lives_ok(
  $$insert into public.lists (id, name, owner_id) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Equipo Tenzor', '11111111-1111-1111-1111-111111111111')$$,
  'a user creates a list she owns');
select results_eq(
  $$select email, accepted_at is not null from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  $$values ('ana@example.com', true)$$, 'the owner is an accepted member of her own list');
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
  $$select email, accepted_at is null from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000001' and email <> 'ana@example.com' order by email$$,
  $$values ('beto@example.com', true), ('carla@example.com', true), ('eve@example.com', true)$$,
  'invitations wait for the invited person to accept');
select throws_ok(
  $$insert into public.list_members (list_id, email, accepted_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'dani@example.com', now())$$,
  '42501', null, 'the owner cannot accept for someone else');

select lives_ok(
  $$insert into public.shared_tasks (id, list_id, name, assignee_email) values
    ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Preparar agenda', 'ana@example.com')$$,
  'the owner creates a task for herself');
select is((select created_by from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'the creator is the signed-in user');
select throws_ok(
  $$insert into public.shared_tasks (list_id, name, assignee_email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X', 'beto@example.com')$$,
  '42501', null, 'a task cannot be assigned to someone who has not accepted');
select throws_ok(
  $$insert into public.shared_tasks (list_id, name, assignee_email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X', 'dani@example.com')$$,
  '42501', null, 'a task cannot be assigned to someone outside the list');
select throws_ok(
  $$insert into public.shared_tasks (list_id, name, created_by) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X', '22222222-2222-2222-2222-222222222222')$$,
  '42501', null, 'nobody creates a task in someone else''s name');
select is((select count(*)::int from public.profiles), 1, 'the owner does not see an invited person before they accept');

-- ---------- Beto, invited ----------
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select results_eq($$select name from public.lists$$, $$values ('Equipo Tenzor')$$, 'an invited person sees the list name');
select results_eq($$select name from public.profiles order by name$$, $$values ('Ana Ruiz'), ('Beto Paz')$$,
  'an invited person sees who invited him');
select is_empty($$select 1 from public.shared_tasks$$, 'an invited person sees no task before accepting');
select results_eq($$select email from public.list_members$$, $$values ('beto@example.com')$$,
  'an invited person sees only his own invitation');
select throws_ok(
  $$insert into public.shared_tasks (list_id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X')$$,
  '42501', null, 'an invited person cannot add tasks before accepting');
select is(pg_temp.affected($$update public.list_members set accepted_at = now() where email = 'carla@example.com'$$), 0,
  'nobody accepts an invitation for someone else');
select throws_ok(
  $$update public.list_members set email = 'otro@example.com' where email = 'beto@example.com'$$,
  '42501', null, 'an invitation keeps its email');
select is(public.is_accepted('aaaaaaaa-0000-0000-0000-000000000001', 'ana@example.com'), false,
  'an invited person cannot probe who joined the list');

select is(
  pg_temp.affected($$update public.list_members set accepted_at = '2000-01-01' where list_id = 'aaaaaaaa-0000-0000-0000-000000000001' and email = 'beto@example.com'$$),
  1, 'the invited person accepts');
select ok((select accepted_at > '2020-01-01' from public.list_members where email = 'beto@example.com'),
  'accepting records the real time, not the one sent');
select is((select count(*)::int from public.shared_tasks), 1, 'a member sees every task of the list');
select is((select count(*)::int from public.list_members), 4, 'a member sees the members and the pending invitations');

-- ---------- Ana, once Beto accepted ----------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select count(*)::int from public.profiles), 2, 'the owner sees a member once he accepted');
select lives_ok(
  $$insert into public.shared_tasks (id, list_id, name, assignee_email) values
    ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Revisar contrato', 'beto@example.com')$$,
  'a member creates tasks assigned to an accepted member');

-- ---------- Beto, a member ----------
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

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
  'P0001', 'Una tarea no cambia de id, creador ni lista.', 'the creator of a task never changes');
select throws_ok(
  $$update public.shared_tasks set status = 'lista' where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  '23514', null, 'the status is one of the five Pendientes statuses');
select throws_ok(
  $$update public.shared_tasks set assignee_email = 'carla@example.com' where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  '42501', null, 'a task cannot be handed to someone who has not accepted');

select is(pg_temp.affected($$delete from public.list_members where email = 'carla@example.com'$$), 0,
  'a member who is not the owner cannot remove anyone');
select throws_ok(
  $$insert into public.list_members (list_id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'dani@example.com')$$,
  '42501', null, 'a member who is not the owner cannot invite');
select is(pg_temp.affected($$update public.lists set name = 'Mía'$$), 0, 'a member who is not the owner cannot rename the list');
select is(pg_temp.affected($$delete from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000002'$$), 0,
  'a member cannot delete a task he did not create');
select lives_ok(
  $$insert into public.shared_tasks (id, list_id, name, assignee_email) values
    ('bbbbbbbb-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'Pedido de Beto', 'ana@example.com')$$,
  'a member creates a task for the owner');

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

select is_empty($$select 1 from public.lists$$, 'an unconfirmed email does not see an invitation');
select is(pg_temp.affected($$update public.list_members set accepted_at = now() where email = 'eve@example.com'$$), 0,
  'an unconfirmed email cannot accept an invitation');

-- ---------- Nobody signed in ----------
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select 1 from public.lists$$, '42501', null, 'the anonymous role reads nothing');

-- ---------- Dani declines an invitation ----------
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.list_members (list_id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'dani@example.com');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select results_eq($$select name from public.lists$$, $$values ('Equipo Tenzor')$$, 'an invitation shows up for the invited person');
select is(pg_temp.affected($$delete from public.list_members where email = 'dani@example.com'$$), 1, 'the invited person declines');
select is_empty($$select 1 from public.lists$$, 'a declined invitation is gone');

-- ---------- Carla signs up after being invited, accepts, then leaves ----------
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
  ('33333333-3333-3333-3333-333333333333', 'carla@example.com', now(), '{"name":"Carla"}', 'authenticated', 'authenticated');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select results_eq($$select name from public.lists$$, $$values ('Equipo Tenzor')$$,
  'an invitation made before signing up shows up after signing in');
select is(pg_temp.affected($$update public.list_members set accepted_at = now() where email = 'carla@example.com'$$), 1,
  'she accepts');

set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into public.shared_tasks (id, list_id, name, assignee_email) values
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Llamar al cliente', 'carla@example.com');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is(
  pg_temp.affected($$update public.shared_tasks set assignee_email = 'beto@example.com' where id = 'bbbbbbbb-0000-0000-0000-000000000003'$$),
  1, 'the assignee hands a task to another member');
select lives_ok(
  $$insert into public.shared_tasks (id, list_id, name, assignee_email) values
    ('bbbbbbbb-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Tarea de Carla', 'carla@example.com'),
    ('bbbbbbbb-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'Encargo de Carla para Beto', 'beto@example.com')$$,
  'Carla creates one task for herself and one for Beto');

select is(pg_temp.affected($$delete from public.list_members where email = 'carla@example.com'$$), 1, 'a member leaves the list');
select is_empty($$select 1 from public.lists$$, 'after leaving, the list is gone for her');
-- A filter that reads no column skips the read policy; the delete policy must stand on its own.
select is(pg_temp.affected($$delete from public.shared_tasks where true$$), 0,
  'after leaving, she cannot delete the tasks she created there');

reset role;
select is_empty($$select 1 from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000004'$$,
  'leaving deletes the tasks assigned to her');
select results_eq($$select name from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000006'$$,
  $$values ('Encargo de Carla para Beto')$$, 'tasks she created for others stay');

-- ---------- Ana removes Beto ----------
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok($$delete from public.list_members where email = 'ana@example.com'$$,
  'P0001', 'El dueño no puede salir de su propia lista.', 'the owner cannot leave her own list');
select throws_ok($$update public.lists set owner_id = '22222222-2222-2222-2222-222222222222'$$,
  '42501', null, 'a list keeps its one owner');
select lives_ok($$delete from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000007'$$,
  'the owner deletes a task she did not create');
select lives_ok($$delete from public.list_members where email = 'beto@example.com'$$, 'the owner removes a member');
select is_empty($$select 1 from public.shared_tasks where assignee_email = 'beto@example.com'$$,
  'removing a member deletes the tasks assigned to him');
select results_eq($$select name from public.shared_tasks$$, $$values ('Preparar agenda')$$,
  'the owner''s own task stays');

set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select is_empty($$select 1 from public.lists$$, 'a removed member no longer sees the list');

-- ---------- Ana deletes the list ----------
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$delete from public.lists where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, 'the owner deletes her list');
reset role;
select is_empty($$select 1 from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'deleting a list deletes its members');
select is_empty($$select 1 from public.shared_tasks where list_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'deleting a list deletes its tasks');

-- ---------- Who changed a task, and when, cannot be made up ----------
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
insert into public.lists (id, name, owner_id) values ('aaaaaaaa-0000-0000-0000-000000000002', 'Lista de Beto', '22222222-2222-2222-2222-222222222222');
insert into public.shared_tasks (id, list_id, name, updated_by, created_at, updated_at) values
  ('bbbbbbbb-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002', 'Falsa', '11111111-1111-1111-1111-111111111111', '2000-01-01', '2000-01-01');
select is((select updated_by from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000009'),
  '22222222-2222-2222-2222-222222222222'::uuid, 'a new task records its real author as the last to change it');
select ok((select created_at > '2020-01-01' and updated_at > '2020-01-01' from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000009'),
  'a new task gets the real time, not the one sent');
select throws_ok($$update public.shared_tasks set id = gen_random_uuid() where id = 'bbbbbbbb-0000-0000-0000-000000000009'$$,
  'P0001', 'Una tarea no cambia de id, creador ni lista.', 'a task keeps its id');

insert into public.shared_tasks (id, list_id, name, assignee_email) values
  ('bbbbbbbb-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000002', 'Mía', 'beto@example.com');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
insert into public.lists (id, name, owner_id) values ('aaaaaaaa-0000-0000-0000-000000000003', 'Lista de Dani', '44444444-4444-4444-4444-444444444444');
insert into public.list_members (list_id, email) values ('aaaaaaaa-0000-0000-0000-000000000003', 'beto@example.com');

-- ---------- A changed email moves the profile, the memberships and the assigned tasks ----------
reset role;
update auth.users set email = 'Beto.Nuevo@example.com' where id = '22222222-2222-2222-2222-222222222222';
select is((select email from public.profiles where id = '22222222-2222-2222-2222-222222222222'), 'beto.nuevo@example.com',
  'the profile email follows the account email');
select is_empty($$select 1 from public.list_members where email = 'beto@example.com'$$,
  'no membership stays under the old email, for someone else to inherit');
select is((select assignee_email from public.shared_tasks where id = 'bbbbbbbb-0000-0000-0000-000000000010'), 'beto.nuevo@example.com',
  'tasks assigned to the old email move to the new one');
select results_eq(
  $$select email, accepted_at is null from public.list_members where list_id = 'aaaaaaaa-0000-0000-0000-000000000003' and email like 'beto%'$$,
  $$values ('beto.nuevo@example.com', true)$$,
  'a pending invitation moves to the new email and still waits for an answer');
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
select results_eq($$select name from public.lists order by name$$, $$values ('Lista de Beto'), ('Lista de Dani')$$,
  'after changing email he keeps his lists and his pending invitation');
reset role;

-- ---------- Only signed-in users reach the helpers; no extra table rights ----------
select ok(not has_function_privilege('anon', 'public.current_email()', 'execute')
  and not has_function_privilege('anon', 'public.is_member(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.is_invited(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.is_owner(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.is_accepted(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.shares_list_with(text)', 'execute'),
  'the anonymous role cannot run the membership helpers');
select ok(not has_table_privilege('authenticated', 'public.lists', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.list_members', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.shared_tasks', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'),
  'signed-in users cannot truncate, which skips row level security');

select * from finish();
rollback;
