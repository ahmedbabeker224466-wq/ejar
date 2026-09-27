-- 0001_init.sql
-- Core schema for Aqdi: offices, landlords, units, contracts, tenants, reminders.
--
-- Privacy: there is deliberately no column anywhere for party names, national ID /
-- iqama numbers, IBAN, utility meter numbers or full addresses.
--
-- Joining with an invite code (setting landlords.user_id, adding contract_members)
-- is not granted to users directly; it will go through a server-side function later.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text check (role in ('office', 'landlord', 'tenant')),
  display_name text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.offices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid()
    references public.profiles (id) on delete cascade,
  name text not null,
  plan text not null default 'trial',
  trial_ends_at timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now()
);

create table public.landlords (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  -- A nickname typed by the office, never copied from a contract.
  label text not null,
  created_at timestamptz not null default now(),
  -- Lets child tables require that a landlord belongs to the same office.
  unique (id, office_id)
);

create table public.units (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices (id) on delete cascade,
  landlord_id uuid not null,
  label text not null,
  city text not null,
  district text,
  notes text,
  status text not null default 'vacant' check (status in ('vacant', 'rented')),
  created_at timestamptz not null default now(),
  unique (id, office_id),
  foreign key (landlord_id, office_id) references public.landlords (id, office_id)
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices (id) on delete cascade,
  landlord_id uuid,
  unit_id uuid,
  contract_number text,
  start_date date not null,
  end_date date not null,
  hijri_start text,
  hijri_end text,
  annual_rent numeric not null check (annual_rent > 0),
  payment_frequency text
    check (payment_frequency in ('monthly', 'quarterly', 'semiannual', 'annual')),
  -- Array of {"due_date": "YYYY-MM-DD", "amount": number}.
  payments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(payments) = 'array'),
  city text,
  ai_confidence text,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date > start_date),
  unique (id, office_id),
  -- Same-office guarantees; deleting the landlord or unit only clears the link.
  foreign key (landlord_id, office_id)
    references public.landlords (id, office_id) on delete set null (landlord_id),
  foreign key (unit_id, office_id)
    references public.units (id, office_id) on delete set null (unit_id)
);

create table public.contract_members (
  contract_id uuid not null references public.contracts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('landlord', 'tenant')),
  primary key (contract_id, user_id)
);

-- 8 characters from an alphabet without the look-alikes 0 O 1 I L.
create function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  random_bytes bytea := uuid_send(gen_random_uuid());
  code text := '';
begin
  for i in 0..7 loop
    code := code || substr(alphabet, 1 + get_byte(random_bytes, i) % length(alphabet), 1);
  end loop;
  return code;
end;
$$;

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.generate_invite_code()
    check (code ~ '^[A-HJKMNP-Z2-9]{8}$'),
  kind text not null check (kind in ('landlord', 'tenant')),
  office_id uuid not null references public.offices (id) on delete cascade,
  landlord_id uuid,
  contract_id uuid,
  used_by uuid references public.profiles (id) on delete set null,
  used_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now(),
  -- A landlord invite points at a landlord; a tenant invite points at a contract.
  check (
    (kind = 'landlord' and landlord_id is not null and contract_id is null)
    or (kind = 'tenant' and contract_id is not null)
  ),
  foreign key (landlord_id, office_id)
    references public.landlords (id, office_id) on delete cascade,
  foreign key (contract_id, office_id)
    references public.contracts (id, office_id) on delete cascade
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (
    kind in ('rent_change_deadline', 'decision_deadline', 'end_30', 'end_7', 'payment_due')
  ),
  remind_on date not null,
  sent_at timestamptz,
  channel text not null default 'push',
  unique (contract_id, user_id, kind, remind_on)
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  contact text not null check (char_length(contact) between 3 and 100),
  kind text check (char_length(kind) <= 30),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (foreign keys + deadline queries)
-- ---------------------------------------------------------------------------

create index offices_owner_id_idx on public.offices (owner_id);
create index landlords_office_id_idx on public.landlords (office_id);
create index landlords_user_id_idx on public.landlords (user_id);
create index units_office_id_idx on public.units (office_id);
create index units_landlord_id_idx on public.units (landlord_id);
create index contracts_office_id_idx on public.contracts (office_id);
create index contracts_landlord_id_idx on public.contracts (landlord_id);
create index contracts_unit_id_idx on public.contracts (unit_id);
create index contracts_created_by_idx on public.contracts (created_by);
create index contracts_end_date_idx on public.contracts (end_date);
create index contract_members_user_id_idx on public.contract_members (user_id);
create index invites_office_id_idx on public.invites (office_id);
create index invites_landlord_id_idx on public.invites (landlord_id);
create index invites_contract_id_idx on public.invites (contract_id);
create index invites_used_by_idx on public.invites (used_by);
create index reminders_user_id_idx on public.reminders (user_id);
create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- Helper functions for policies
-- Security definer so policies can look across tables without recursing into
-- each other's RLS. Kept in a schema that the Supabase API does not expose.
-- ---------------------------------------------------------------------------

create schema private;
grant usage on schema private to authenticated;

create function private.is_office_owner(p_office_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.offices
    where id = p_office_id and owner_id = auth.uid()
  );
$$;

create function private.is_landlord_user(p_landlord_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.landlords
    where id = p_landlord_id and user_id = auth.uid()
  );
$$;

create function private.is_contract_member(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.contract_members
    where contract_id = p_contract_id and user_id = auth.uid()
  );
$$;

create function private.owns_contract_office(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.contracts c
    join public.offices o on o.id = c.office_id
    where c.id = p_contract_id and o.owner_id = auth.uid()
  );
$$;

-- True when the current user may read the contract in any role.
create function private.can_read_contract(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.contracts c
    where c.id = p_contract_id
      and (
        exists (select 1 from public.offices o
                where o.id = c.office_id and o.owner_id = auth.uid())
        or exists (select 1 from public.landlords l
                   where l.id = c.landlord_id and l.user_id = auth.uid())
        or exists (select 1 from public.contract_members m
                   where m.contract_id = c.id and m.user_id = auth.uid())
      )
  );
$$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges
-- Anonymous visitors may only add themselves to the waitlist. Columns that
-- grant access to other people (landlords.user_id, invites.used_by, ...) are
-- not writable by users at all.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

grant insert (contact, kind) on public.waitlist to anon;

grant select, insert (id, role, display_name, phone), update (role, display_name, phone)
  on public.profiles to authenticated;
grant select, insert (name), update (name), delete
  on public.offices to authenticated;
grant select, insert (office_id, label), update (label), delete
  on public.landlords to authenticated;
grant select, delete,
  insert (office_id, landlord_id, label, city, district, notes, status),
  update (landlord_id, label, city, district, notes, status)
  on public.units to authenticated;
grant select, delete,
  insert (office_id, landlord_id, unit_id, contract_number, start_date, end_date,
          hijri_start, hijri_end, annual_rent, payment_frequency, payments, city,
          ai_confidence),
  update (landlord_id, unit_id, contract_number, start_date, end_date, hijri_start,
          hijri_end, annual_rent, payment_frequency, payments, city, ai_confidence)
  on public.contracts to authenticated;
grant select, delete on public.contract_members to authenticated;
grant select, insert (kind, office_id, landlord_id, contract_id), delete
  on public.invites to authenticated;
grant select, insert (contract_id, user_id, kind, remind_on, channel),
  update (remind_on, channel), delete
  on public.reminders to authenticated;
grant select, insert (user_id, endpoint, keys), delete
  on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.offices enable row level security;
alter table public.landlords enable row level security;
alter table public.units enable row level security;
alter table public.contracts enable row level security;
alter table public.contract_members enable row level security;
alter table public.invites enable row level security;
alter table public.reminders enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.waitlist enable row level security;

-- profiles: own row only.
create policy profiles_own on public.profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- offices: the owner.
create policy offices_owner on public.offices
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- landlords: the office owner; a joined landlord reads his own row.
create policy landlords_office_owner on public.landlords
  for all to authenticated
  using (private.is_office_owner(office_id))
  with check (private.is_office_owner(office_id));

create policy landlords_self_read on public.landlords
  for select to authenticated
  using (user_id = (select auth.uid()));

-- units: the office owner; the landlord reads his units.
create policy units_office_owner on public.units
  for all to authenticated
  using (private.is_office_owner(office_id))
  with check (private.is_office_owner(office_id));

create policy units_landlord_read on public.units
  for select to authenticated
  using (private.is_landlord_user(landlord_id));

-- contracts: the office owner; the landlord through his landlords row (so contracts
-- saved before he joined are included); tenants through contract_members.
create policy contracts_office_owner on public.contracts
  for all to authenticated
  using (private.is_office_owner(office_id))
  with check (
    private.is_office_owner(office_id)
    and created_by = (select auth.uid())
  );

create policy contracts_landlord_read on public.contracts
  for select to authenticated
  using (private.is_landlord_user(landlord_id));

create policy contracts_member_read on public.contracts
  for select to authenticated
  using (private.is_contract_member(id));

-- contract_members: the office owner of the contract; members see their own rows.
create policy contract_members_office_owner on public.contract_members
  for all to authenticated
  using (private.owns_contract_office(contract_id))
  with check (private.owns_contract_office(contract_id));

create policy contract_members_self_read on public.contract_members
  for select to authenticated
  using (user_id = (select auth.uid()));

-- invites: the office owner.
create policy invites_office_owner on public.invites
  for all to authenticated
  using (private.is_office_owner(office_id))
  with check (private.is_office_owner(office_id));

-- reminders: own rows, only for contracts the user can read.
create policy reminders_own on public.reminders
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and private.can_read_contract(contract_id)
  );

-- push_subscriptions: own rows.
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- waitlist: anonymous insert only; nobody reads through the API.
create policy waitlist_anon_insert on public.waitlist
  for insert to anon
  with check (true);
