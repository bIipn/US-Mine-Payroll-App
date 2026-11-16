-- MineMuster, step 1: notifications for a company's supervisors.
--
-- join_company writes one when someone joins by claiming their row ('joined')
-- and one when it leaves a new join request ('join_request'). Every
-- supervisor of the company sees the same notifications, and read_at is
-- shared: marking one read marks it read for all of them. Notifications are
-- written only by the functions; through the API a supervisor can only read
-- them and set read_at.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  -- The row that was claimed, for 'joined'.
  roster_id uuid,
  -- The request that was left, for 'join_request'.
  request_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz,

  constraint notifications_kind_check check (kind in ('joined', 'join_request')),
  constraint notifications_points_at_one_thing check (
    (kind = 'joined' and roster_id is not null and request_id is null)
    or (kind = 'join_request' and request_id is not null and roster_id is null)
  ),
  -- What it points at belongs to the same company, and goes with it.
  constraint notifications_roster_same_company foreign key (company_id, roster_id)
    references public.roster (company_id, id) on delete cascade,
  constraint notifications_request_same_company foreign key (company_id, request_id)
    references public.join_requests (company_id, id) on delete cascade
);

create index notifications_company_created_idx on public.notifications (company_id, created_at desc);
create index notifications_roster_idx on public.notifications (company_id, roster_id) where roster_id is not null;
create index notifications_request_idx on public.notifications (company_id, request_id) where request_id is not null;

-- Locked until the row level security migration grants what each role may do.
alter table public.notifications enable row level security;
revoke all on table public.notifications from public, anon, authenticated;
