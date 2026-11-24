-- MineMuster, step 1: the roster.
--
-- Everyone who works for a company, the way the company writes their name. A
-- supervisor puts people on it. A person's account claims their row when they
-- join, and from then on that row is them in the company.
--
-- Claims:
--  * A row is claimed by at most one account, and no account takes over a row
--    another holds: it has to be released first (release_roster_claim, by a
--    supervisor). Deleting the account lets go of the row too.
--  * An account holds at most one row in a company, active or not. It may hold
--    rows in several companies.
--  * user_id and claimed_at are written only by the functions, never through
--    the API (see the row level security migration).

create table public.roster (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  -- Job title, as the company writes it.
  title text,
  role text not null default 'employee',
  -- Taken off the roster when false. Inactive rows are never matched to a
  -- typed name, and their account is not a member.
  active boolean not null default true,
  -- The account that claimed this row, and when.
  user_id uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),

  -- Lets join_requests and notifications point at a row of their own company only.
  constraint roster_company_id_id_key unique (company_id, id),
  constraint roster_role_check check (role in ('employee', 'supervisor')),
  constraint roster_first_name_length check (char_length(btrim(first_name)) between 1 and 100),
  constraint roster_last_name_length check (char_length(btrim(last_name)) between 1 and 100),
  constraint roster_title_length check (title is null or char_length(btrim(title)) between 1 and 100),
  constraint roster_claim_is_whole check ((user_id is null) = (claimed_at is null))
);

-- One row per account in a company.
create unique index roster_one_row_per_account on public.roster (company_id, user_id) where user_id is not null;
-- Every company an account belongs to, and the account's rows when it is deleted.
create index roster_user_id_idx on public.roster (user_id) where user_id is not null;

-- Locked until the row level security migration grants what each role may do.
alter table public.roster enable row level security;
revoke all on table public.roster from public, anon, authenticated;

-- Tidies what is written and keeps what must not change.
--  * Names and the title are trimmed with their runs of spaces closed up, the
--    way they are matched; a blank title is no title.
--  * A row never moves to another company.
--  * A claimed row is never handed straight to another account: the claim is
--    released (user_id set to null) first.
--  * claimed_at goes with user_id: cleared when the claim is released, and
--    filled in when a claim arrives without one.
-- Security definer so it can call the private helpers whoever is writing.
create function public.roster_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.first_name := public.clean_text(new.first_name);
  new.last_name := public.clean_text(new.last_name);
  new.title := nullif(public.clean_text(new.title), '');

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      raise exception using
        errcode = '42501',
        message = 'A roster row cannot move to another company.';
    end if;
    if old.user_id is not null and new.user_id is not null and new.user_id <> old.user_id then
      raise exception using
        errcode = '55000',
        message = 'That roster row is already claimed by another account.',
        hint = 'A supervisor can release it first.';
    end if;
  end if;

  if new.user_id is null then
    new.claimed_at := null;
  elsif new.claimed_at is null then
    new.claimed_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

revoke all on function public.roster_before_write() from public, anon, authenticated, service_role;

create trigger roster_before_write
  before insert or update on public.roster
  for each row execute function public.roster_before_write();
