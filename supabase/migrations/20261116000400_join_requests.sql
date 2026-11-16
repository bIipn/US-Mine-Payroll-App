-- MineMuster, step 1: join requests.
--
-- When someone with the company's join code types a name that is not on the
-- roster, or that belongs to a row another account has already claimed,
-- join_company leaves a request here for the company's supervisors. A
-- supervisor approves it (onto an existing row or a new one) or denies it.
-- Requests are written only by the functions, never through the API.

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- The account asking to join. Its requests go when the account is deleted.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The name as the person typed it, trimmed with its runs of spaces closed up.
  first_name text not null,
  last_name text not null,
  -- Why the name did not join by itself.
  reason text not null,
  status text not null default 'pending',
  -- The roster row the request was approved onto.
  roster_id uuid,
  -- The supervisor who decided, and when.
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),

  -- Lets notifications point at a request of their own company only.
  constraint join_requests_company_id_id_key unique (company_id, id),
  constraint join_requests_reason_check check (reason in ('not_on_roster', 'already_claimed')),
  constraint join_requests_status_check check (status in ('pending', 'approved', 'denied')),
  constraint join_requests_first_name_length check (char_length(btrim(first_name)) between 1 and 100),
  constraint join_requests_last_name_length check (char_length(btrim(last_name)) between 1 and 100),
  -- A request is decided exactly when it is no longer pending.
  constraint join_requests_decided_when_not_pending check ((status = 'pending') = (decided_at is null)),
  constraint join_requests_pending_is_undecided check (status <> 'pending' or (roster_id is null and decided_by is null)),
  -- The row it was approved onto is one of the same company's. If that row is
  -- deleted later, the request stays and only forgets the row.
  constraint join_requests_roster_same_company foreign key (company_id, roster_id)
    references public.roster (company_id, id) on delete set null (roster_id)
);

-- One pending request per account and company.
create unique index join_requests_one_pending on public.join_requests (company_id, user_id) where status = 'pending';
create index join_requests_user_id_idx on public.join_requests (user_id);
create index join_requests_roster_idx on public.join_requests (company_id, roster_id) where roster_id is not null;
create index join_requests_decided_by_idx on public.join_requests (decided_by) where decided_by is not null;

-- Locked until the row level security migration grants what each role may do.
alter table public.join_requests enable row level security;
revoke all on table public.join_requests from public, anon, authenticated;
