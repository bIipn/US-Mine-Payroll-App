-- MineMuster, step 1: companies.
--
-- One row for each company that uses the app: a mine, a plant or a contractor.
-- Its people are on its roster (next migration). Nobody reads or changes a
-- company through the API until the row level security migration says who may.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  -- The company's name as its people know it.
  name text not null,
  -- What a new person types to find the company. Made by the database, and
  -- changed only by rotate_join_code.
  join_code text not null,
  -- Two-letter postal code of the state its hours rules follow.
  state text not null,
  -- IANA time zone its days and pay periods are counted in.
  timezone text not null default 'America/Los_Angeles',
  -- Path of the company's logo in storage. The logo is optional.
  logo_path text,
  -- The company's pay period rule. Null means none is set.
  pay_period jsonb,
  -- The account that made the company.
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint companies_join_code_key unique (join_code),
  constraint companies_name_length check (char_length(btrim(name)) between 1 and 120),
  -- Eight characters with no look-alikes: no 0 or O, no 1 or I.
  constraint companies_join_code_format check (join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  -- The 50 states and the District of Columbia.
  constraint companies_state_code check (state in (
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
    'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
    'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
    'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
    'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI',
    'WY'
  )),
  constraint companies_timezone_length check (char_length(timezone) between 1 and 64),
  constraint companies_logo_path_length check (logo_path is null or char_length(logo_path) between 1 and 1024),
  constraint companies_pay_period_is_object check (pay_period is null or jsonb_typeof(pay_period) = 'object')
);

create index companies_created_by_idx on public.companies (created_by) where created_by is not null;

-- Locked until the row level security migration grants what each role may do.
alter table public.companies enable row level security;
revoke all on table public.companies from public, anon, authenticated;

-- Tidies what is written and keeps what must not change.
--  * The name is trimmed with its runs of spaces closed up, the state is put
--    in capitals, and a blank logo path is no logo.
--  * The time zone must be one PostgreSQL knows.
--  * id and created_at never change, and created_by changes only to nothing,
--    when that account is deleted.
--  * updated_at is the time of the last change.
-- Security definer so it can call the private helpers whoever is writing.
create function public.companies_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.name := public.clean_text(new.name);
  new.state := pg_catalog.upper(public.clean_text(new.state));
  new.timezone := public.clean_text(new.timezone);
  new.logo_path := nullif(public.clean_text(new.logo_path), '');

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or (new.created_by is distinct from old.created_by and new.created_by is not null) then
      raise exception using
        errcode = '42501',
        message = 'A company''s id, creator and creation time cannot be changed.';
    end if;
    new.updated_at := pg_catalog.now();
  end if;

  if (tg_op = 'INSERT' or new.timezone is distinct from old.timezone)
     and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception using
      errcode = '22023',
      message = 'That is not a time zone the database knows.',
      hint = 'Use an IANA name such as America/Los_Angeles.';
  end if;

  return new;
end;
$$;

revoke all on function public.companies_before_write() from public, anon, authenticated, service_role;

create trigger companies_before_write
  before insert or update on public.companies
  for each row execute function public.companies_before_write();

-- A new join code: eight characters from the 32 without look-alikes, drawn
-- from gen_random_uuid(), which uses the server's cryptographically strong
-- random source. Of a version 4 UUID's 16 bytes, all but bytes 6 and 8 are
-- wholly random; eight of those are used, and since 256 is a multiple of 32
-- each byte picks a character with no bias. A code already in use is drawn
-- again; the unique constraint settles the rare race between two at once.
create function public.new_join_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  random_bytes bytea;
  code text;
  i integer;
begin
  loop
    random_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
    code := '';
    foreach i in array array[0, 1, 2, 3, 4, 5, 7, 9] loop
      code := code || pg_catalog.substr(alphabet, pg_catalog.get_byte(random_bytes, i) % 32 + 1, 1);
    end loop;
    exit when not exists (select 1 from public.companies c where c.join_code = code);
  end loop;
  return code;
end;
$$;

revoke all on function public.new_join_code() from public, anon, authenticated, service_role;
