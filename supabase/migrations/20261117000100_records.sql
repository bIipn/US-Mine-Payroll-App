-- MineMuster, step 2: the records the crew's phones share.
--
-- Everything a person does in the app is saved on their phone first, signal
-- or not, and sent to the company when the phone can reach it
-- (src/domain/sync.ts). These two tables keep what the phones send:
--
--  * records: the latest version of each record a company's phones have sent,
--    one row per record, keyed by its kind and its id on the phone.
--  * record_history: every version the server took, never changed afterwards.
--    A signed record is not rewritten: when a record changes, its new version
--    is added here and the old one stays.
--
-- Two more are push_records' own, and nobody reads or writes them through the
-- API: record_counters, each company's count of versions taken (see seq
-- below), and record_usage, how much each account has sent today.
--
-- Nobody writes any of them through the API, not even the server key: only
-- push_records does (migration 20261117000300), and it decides who may write
-- what. Who reads what is the next migration. The tables are locked here, in
-- the file that makes them, and keep no planner statistics, as the README asks.
--
-- A record's kind is one of the eleven the app sends, in the order it sends
-- them (SYNC_KINDS in src/domain/sync.ts). Its id is the phone's own id for it;
-- the shared settings have the one id 'company'. Its rev is the phone's version
-- of it: a hash of the record as it is, or 'deleted' for one taken off a phone.
--
-- record_history counts each record's versions 1, 2, 3, ... rather than
-- numbering every row from one sequence: a counter shared by every company
-- would tell a member how many versions other companies sent between two of
-- their own. For the same reason seq, the number a client pulls changes by, is
-- counted per company: every version a company's phones send gets the next one,
-- under a lock push_records holds until the call commits, so a company's seq
-- order is the order its changes became visible.
--
-- How big a record may be is checked without writing it out as text first.
-- jsonb keeps a number such as 1e131071 in a few bytes, and its text is
-- 131,072 characters; a record of a few thousand of them would take a gigabyte
-- to write out. So a record is first held to 1 MB as stored, then refused if it
-- holds a number no phone sends (JSON.stringify writes nothing past
-- +-1.8e308, and nothing nearer zero than 5e-324), and only then held to
-- 256 KB as text.

create table public.records (
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null,
  id text not null,
  -- The version the phone sent, or 'deleted'.
  rev text not null,
  -- The record as the phone sent it: a JSON object. An empty object once the
  -- record is deleted; what it held stays in record_history.
  data jsonb not null,
  deleted boolean not null default false,
  -- How many versions of it the server has taken: the version of its newest
  -- row in record_history.
  version integer not null default 1,
  -- The company's number for its latest version (the seq of that row in
  -- record_history). A client pulls what changed after the last seq it has.
  seq bigint not null,
  -- The account that first sent it, and the one that sent its latest version.
  created_by uuid references auth.users (id) on delete set null,
  -- Whether that first account was a supervisor of the company when it sent
  -- it. What an account sent as a supervisor stays a supervisor's if the
  -- account is later made an employee: it no longer reads or changes it.
  created_by_supervisor boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint records_pkey primary key (company_id, kind, id),
  constraint records_kind_check check (kind in (
    'settings', 'employee', 'equipment', 'areaSheet', 'shift', 'denied',
    'leave', 'inspection', 'opLog', 'exam', 'mrf'
  )),
  -- C0 and C1 control characters and DEL.
  constraint records_id_format check (
    pg_catalog.char_length(id) between 1 and 120 and id !~ '[\x01-\x1f\x7f-\x9f]'
  ),
  constraint records_rev_format check (
    pg_catalog.char_length(rev) between 1 and 64 and rev !~ '[\x01-\x1f\x7f-\x9f]'
  ),
  constraint records_data_is_object check (pg_catalog.jsonb_typeof(data) = 'object'),
  -- 1 MB as stored, no number a phone never sends, then 256 KB as JSON text,
  -- in that order (see above). CASE keeps the order.
  constraint records_data_size check (
    case
      when pg_catalog.pg_column_size(data) > 1048576 then false
      when pg_catalog.jsonb_path_exists(data, 'strict $.** ? (@.type() == "number" && (@ > 1.8e308 || @ < -1.8e308 || (@ != 0 && @ < 4.9e-324 && @ > -4.9e-324)))') then false
      else pg_catalog.octet_length(data::text) <= 262144
    end
  ),
  constraint records_deleted_rev check (deleted = (rev = 'deleted')),
  constraint records_deleted_data check (not deleted or data = '{}'::jsonb),
  constraint records_version_check check (version >= 1),
  constraint records_seq_check check (seq >= 1)
);

-- What changed in a company: page with seq > the last one read, in seq order.
create unique index records_seq on public.records (company_id, seq);
-- When things changed, for showing. Not for pulling: every change of one call
-- has the same updated_at, and a call that started first can commit last.
create index records_updated_at on public.records (company_id, updated_at);
-- An account's records, and what its foreign keys clear when it is deleted.
create index records_created_by_idx on public.records (created_by) where created_by is not null;
create index records_updated_by_idx on public.records (updated_by) where updated_by is not null;

create table public.record_history (
  company_id uuid not null,
  kind text not null,
  id text not null,
  -- 1 for the first version of the record the server took, then 2, 3, ...
  version integer not null,
  rev text not null,
  -- The version the sending phone last had confirmed, or null for none.
  base text,
  -- The record as it was sent, or null for a deletion.
  data jsonb,
  deleted boolean not null,
  -- The company's number for this version: one more than the version the
  -- company's phones sent before it.
  seq bigint not null,
  -- The account that sent it, and when the server took it.
  by uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),

  constraint record_history_pkey primary key (company_id, kind, id, version),
  -- Every version belongs to a record, and goes only when the record goes,
  -- which is only when its company is deleted (see the trigger below).
  constraint record_history_record_fkey foreign key (company_id, kind, id)
    references public.records (company_id, kind, id) on delete cascade,
  constraint record_history_version_check check (version >= 1),
  constraint record_history_rev_format check (
    pg_catalog.char_length(rev) between 1 and 64 and rev !~ '[\x01-\x1f\x7f-\x9f]'
  ),
  constraint record_history_base_format check (
    base is null or (pg_catalog.char_length(base) between 1 and 64 and base !~ '[\x01-\x1f\x7f-\x9f]')
  ),
  constraint record_history_data_is_object check (data is null or pg_catalog.jsonb_typeof(data) = 'object'),
  constraint record_history_data_size check (
    case
      when data is null then true
      when pg_catalog.pg_column_size(data) > 1048576 then false
      when pg_catalog.jsonb_path_exists(data, 'strict $.** ? (@.type() == "number" && (@ > 1.8e308 || @ < -1.8e308 || (@ != 0 && @ < 4.9e-324 && @ > -4.9e-324)))') then false
      else pg_catalog.octet_length(data::text) <= 262144
    end
  ),
  constraint record_history_seq_check check (seq >= 1),
  constraint record_history_deleted_rev check (deleted = (rev = 'deleted')),
  constraint record_history_deleted_data check (deleted = (data is null))
);

-- Versions taken after a seq, and since a time (for showing only, as above).
create unique index record_history_seq on public.record_history (company_id, seq);
create index record_history_at_idx on public.record_history (company_id, at);
-- What the foreign key clears when an account is deleted.
create index record_history_by_idx on public.record_history (by) where by is not null;

-- Each company's count of the versions its phones have sent: the seq of the
-- newest. push_records locks the company's row before it looks at any record
-- and holds it until the call commits, so one company's calls take turns and
-- seq order is commit order.
create table public.record_counters (
  company_id uuid primary key references public.companies (id) on delete cascade,
  seq bigint not null default 0,
  constraint record_counters_seq_check check (seq >= 0)
);

-- How much each account has sent today (UTC): versions, and their size as
-- JSON text. push_records stops taking an account's changes for the day past
-- its limits (see that migration); the count starts again the next day.
create table public.record_usage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  day date not null,
  versions integer not null default 0,
  bytes bigint not null default 0,
  constraint record_usage_counts check (versions >= 0 and bytes >= 0)
);

-- Locked until the next migration grants what each role may read. The server
-- key keeps SELECT and nothing else: a record is written by push_records only,
-- so its history always has every version.
alter table public.records enable row level security;
alter table public.record_history enable row level security;
alter table public.record_counters enable row level security;
alter table public.record_usage enable row level security;
revoke all on table public.records from public, anon, authenticated, service_role;
revoke all on table public.record_history from public, anon, authenticated, service_role;
revoke all on table public.record_counters from public, anon, authenticated, service_role;
revoke all on table public.record_usage from public, anon, authenticated, service_role;
grant select on table public.records to service_role;
grant select on table public.record_history to service_role;
grant select on table public.record_counters to service_role;
grant select on table public.record_usage to service_role;

-- No planner statistics, before any of them holds data (see migration
-- 20261116002200 and the README).
do $$
declare
  col record;
begin
  for col in
    select c.oid::pg_catalog.regclass as tbl, a.attname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relname in ('records', 'record_history', 'record_counters', 'record_usage')
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname, a.attnum
  loop
    execute pg_catalog.format('alter table %s alter column %I set statistics 0', col.tbl, col.attname);
  end loop;
end;
$$;

-- A version, once taken, stays as it was sent. Two writes are let through:
--  * Deleting the company: its records go, and their history with them.
--  * Deleting an account: its foreign key clears `by` and changes nothing
--    else. Only once the account is gone, so `by` is not cleared by hand.
-- Everything else is refused, whoever asks through SQL, the owner included:
-- changing a version, deleting one, and TRUNCATE. The owner can still disable
-- or drop the trigger: it stops mistakes and every API-level write, not the
-- database's owner.
-- Not security definer: only the owner can write the table, and the foreign
-- keys' actions run as the owner, which reads companies and auth.users.
create function public.record_history_is_kept()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    -- "by" is quoted: PL/pgSQL reads a bare by as its own keyword.
    if new."by" is null and old."by" is not null
       and (pg_catalog.to_jsonb(new) - 'by') = (pg_catalog.to_jsonb(old) - 'by')
       and not exists (select 1 from auth.users u where u.id = old."by") then
      return new;
    end if;
  elsif tg_op = 'DELETE' then
    if not exists (select 1 from public.companies c where c.id = old.company_id) then
      return old;
    end if;
  end if;
  raise exception using
    errcode = '42501',
    message = 'A record''s history is kept as it was sent: no version is changed or removed.';
end;
$$;

revoke all on function public.record_history_is_kept() from public, anon, authenticated, service_role;

create trigger record_history_is_kept
  before update or delete on public.record_history
  for each row execute function public.record_history_is_kept();

create trigger record_history_is_kept_whole
  before truncate on public.record_history
  for each statement execute function public.record_history_is_kept();
