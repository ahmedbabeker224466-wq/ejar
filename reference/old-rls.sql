-- rls.sql
-- Row Level Security check for the Supabase SQL editor.
-- Run the whole file after 0001_init.sql. It creates fake users and data, checks
-- what each user can see, prints PASS or FAIL per check, and deletes everything it
-- created (deleting the fake auth users cascades to all their rows).

drop table if exists rls_results;
create temp table rls_results (n int, check_name text, result text);

do $$
declare
  owner_a    constant uuid := 'eeeeeeee-0000-4000-8000-000000000001';
  owner_b    constant uuid := 'eeeeeeee-0000-4000-8000-000000000002';
  landlord_a constant uuid := 'eeeeeeee-0000-4000-8000-000000000003';
  landlord_b constant uuid := 'eeeeeeee-0000-4000-8000-000000000004';
  tenant_a   constant uuid := 'eeeeeeee-0000-4000-8000-000000000005';
  tenant_b   constant uuid := 'eeeeeeee-0000-4000-8000-000000000006';
  fake_users constant uuid[] :=
    array[owner_a, owner_b, landlord_a, landlord_b, tenant_a, tenant_b];

  office_a uuid;
  office_b uuid;
  ll_a uuid;
  ll_b uuid;
  unit_a uuid;
  unit_b uuid;
  contract_a uuid;
  contract_b uuid;
  seen int;
  blocked boolean;
begin
  -- Leftovers from an interrupted earlier run.
  delete from auth.users where id = any (fake_users);

  -- Fake users and profiles.
  insert into auth.users (id, aud, role)
  select u, 'authenticated', 'authenticated' from unnest(fake_users) as u;

  insert into public.profiles (id, role) values
    (owner_a, 'office'), (owner_b, 'office'),
    (landlord_a, 'landlord'), (landlord_b, 'landlord'),
    (tenant_a, 'tenant'), (tenant_b, 'tenant');

  -- Office A has two landlords, each with one unit and one contract.
  insert into public.offices (owner_id, name) values (owner_a, 'RLS test office A')
    returning id into office_a;
  insert into public.offices (owner_id, name) values (owner_b, 'RLS test office B')
    returning id into office_b;

  insert into public.landlords (office_id, user_id, label)
    values (office_a, landlord_a, 'Landlord A') returning id into ll_a;
  insert into public.landlords (office_id, user_id, label)
    values (office_a, landlord_b, 'Landlord B') returning id into ll_b;

  insert into public.units (office_id, landlord_id, label, city)
    values (office_a, ll_a, 'Unit A', 'Riyadh') returning id into unit_a;
  insert into public.units (office_id, landlord_id, label, city)
    values (office_a, ll_b, 'Unit B', 'Riyadh') returning id into unit_b;

  insert into public.contracts
    (office_id, landlord_id, unit_id, start_date, end_date, annual_rent, created_by)
    values (office_a, ll_a, unit_a, '2026-01-01', '2026-12-31', 30000, owner_a)
    returning id into contract_a;
  insert into public.contracts
    (office_id, landlord_id, unit_id, start_date, end_date, annual_rent, created_by)
    values (office_a, ll_b, unit_b, '2026-01-01', '2026-12-31', 40000, owner_a)
    returning id into contract_b;

  -- Tenants are members of their own contract only. Landlords are NOT members:
  -- they must see contracts through contracts.landlord_id.
  insert into public.contract_members (contract_id, user_id, role) values
    (contract_a, tenant_a, 'tenant'),
    (contract_b, tenant_b, 'tenant');

  -- 1. Tenant A reads his own contract (control).
  perform set_config('request.jwt.claims',
    json_build_object('sub', tenant_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from public.contracts where id = contract_a;
  execute 'reset role';
  insert into rls_results values (1, 'Tenant A reads his own contract',
    case when seen = 1 then 'PASS' else 'FAIL' end);

  -- 2. Tenant A cannot read tenant B's contract.
  execute 'set local role authenticated';
  select count(*) into seen from public.contracts where id = contract_b;
  execute 'reset role';
  insert into rls_results values (2, 'Tenant A cannot read tenant B''s contract',
    case when seen = 0 then 'PASS' else 'FAIL' end);

  -- 3. Tenant A cannot add himself to tenant B's contract.
  execute 'set local role authenticated';
  begin
    insert into public.contract_members (contract_id, user_id, role)
      values (contract_b, tenant_a, 'tenant');
    blocked := false;
  exception when insufficient_privilege then
    blocked := true;
  end;
  execute 'reset role';
  insert into rls_results values (3, 'Tenant A cannot join tenant B''s contract',
    case when blocked then 'PASS' else 'FAIL' end);

  -- 4. Landlord A reads his own unit (control).
  perform set_config('request.jwt.claims',
    json_build_object('sub', landlord_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from public.units where id = unit_a;
  execute 'reset role';
  insert into rls_results values (4, 'Landlord A reads his own unit',
    case when seen = 1 then 'PASS' else 'FAIL' end);

  -- 5. Landlord A cannot read landlord B's unit (same office).
  execute 'set local role authenticated';
  select count(*) into seen from public.units where id = unit_b;
  execute 'reset role';
  insert into rls_results values (5, 'Landlord A cannot read landlord B''s unit',
    case when seen = 0 then 'PASS' else 'FAIL' end);

  -- 6. Landlord A reads his contract through landlord_id, without membership.
  execute 'set local role authenticated';
  select count(*) into seen from public.contracts where id in (contract_a, contract_b);
  execute 'reset role';
  insert into rls_results values (6, 'Landlord A reads only his own contract',
    case when seen = 1 then 'PASS' else 'FAIL' end);

  -- 7. Owner of office B cannot read anything from office A.
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (select count(*) from public.contracts where office_id = office_a)
       + (select count(*) from public.units where office_id = office_a)
       + (select count(*) from public.landlords where office_id = office_a)
    into seen;
  execute 'reset role';
  insert into rls_results values (7, 'Office B cannot read office A''s data',
    case when seen = 0 then 'PASS' else 'FAIL' end);

  -- 8. Owner of office A reads all of his office's contracts (control).
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into seen from public.contracts where office_id = office_a;
  execute 'reset role';
  insert into rls_results values (8, 'Office A reads all its contracts',
    case when seen = 2 then 'PASS' else 'FAIL' end);

  -- 9. Anonymous visitors cannot read the waitlist.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    perform 1 from public.waitlist limit 1;
    blocked := false;
  exception when insufficient_privilege then
    blocked := true;
  end;
  execute 'reset role';
  insert into rls_results values (9, 'Anonymous visitors cannot read the waitlist',
    case when blocked then 'PASS' else 'FAIL' end);

  -- Clean up: cascades remove profiles, offices and everything under them.
  delete from auth.users where id = any (fake_users);
end;
$$;

select n as "#", check_name as "check", result from rls_results order by n;
