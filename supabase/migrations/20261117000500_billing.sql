-- MineMuster, step 3: billing, and the website's contact form.
--
-- MineMuster is one price per company, paid through Stripe: a 14-day free
-- trial that starts at a Stripe payment link (the card is taken there), then
-- charged monthly until the company cancels in Stripe's billing portal. Stripe
-- tells the server what happened by webhook: the edge function
-- supabase/functions/stripe-webhook checks Stripe's signature and hands the
-- event to apply_stripe_event, below, with the server key. The office
-- dashboard asks company_billing where its company stands.
--
-- The Stripe account is shared with another business, whose products and
-- events reach the same webhook. Only MineMuster's are applied:
--
--  * A checkout is MineMuster's when the session carries metadata app =
--    'minemuster' (Stripe copies a payment link's metadata onto each session it
--    makes) and its client_reference_id is the id of a company here. That is
--    what ties a subscription to a company. The first link stands: a later
--    checkout naming another company never moves a subscription.
--  * A subscription event is MineMuster's when the subscription carries
--    metadata app = 'minemuster' (the payment link sets it), or when it is a
--    subscription a MineMuster checkout already brought in.
--  * Anything else is recorded as seen and changes nothing. Nothing about
--    another business is kept but its events' ids and types.
--  * So is any event from Stripe's test mode (livemode not true): a checkout
--    paid with a test card never opens a real company here.
--
-- Stripe may send an event twice, and in any order. Each event is applied
-- once (stripe_events), and a subscription keeps the state of the newest event
-- applied to it (event_at, Stripe's own event.created): an older event that
-- arrives late changes nothing. A subscription that has ended in Stripe
-- (canceled, incomplete_expired) never starts again there, so no later event
-- brings one of those back.
--
-- Nobody writes these tables through the API, supervisors included. A
-- company's supervisors read its own rows; nobody else does. The owner lets a
-- company in without paying with a row in billing_overrides, written by hand
-- in the SQL editor (see the README).
--
-- What a company pays for is checked here, not only in the dashboard: a
-- supervisor reads the company's records (records, record_history) only while
-- company_has_access says the company has MineMuster. The phones keep sending
-- (push_records is not touched), so no safety record is ever lost, and what
-- the crew reads is unchanged.
--
-- The contact form on minemuster.com sends what a visitor typed to
-- submit_contact_request, with the publishable key and nobody signed in. It is
-- kept in contact_requests, which no API role reads; the owner reads it in the
-- table editor.
--
-- Every table is locked in this file, as the README asks: row level security
-- on, privileges taken from the API roles and given back narrowly, TRUNCATE
-- taken from the server key, and no planner statistics.

-- ---- Subscriptions ---------------------------------------------------------------------------------

-- One row per MineMuster subscription in Stripe, keyed by its id (sub_...).
-- company_id is null until the checkout that made it is seen: Stripe can send
-- the subscription's own events first.
create table public.billing_subscriptions (
  subscription_id text primary key,
  company_id uuid references public.companies (id) on delete cascade,
  customer_id text,
  -- Stripe's status of the subscription. Null while only its checkout has
  -- been seen.
  status text,
  -- When the trial ends (and the first charge is made), and when the period
  -- already paid for ends. Null when Stripe gave none.
  trial_end timestamptz,
  current_period_end timestamptz,
  -- The company has cancelled: nothing more is charged, and the subscription
  -- ends at current_period_end.
  cancel_at_period_end boolean not null default false,
  -- Stripe's event.created of the newest event applied to the status.
  event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint billing_subscriptions_id_format check (subscription_id ~ '^[A-Za-z0-9_]{1,255}$'),
  constraint billing_subscriptions_customer_format check (customer_id is null or customer_id ~ '^[A-Za-z0-9_]{1,255}$'),
  constraint billing_subscriptions_status_check check (status is null or status in (
    'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'
  ))
);

-- A company's subscriptions, and what deleting a company clears.
create index billing_subscriptions_company_idx on public.billing_subscriptions (company_id) where company_id is not null;

-- A company the owner lets in without paying: a friend of the business, a
-- pilot, a company whose card trouble is being sorted out. Until a time, or
-- for good when until is null. Written by hand in the SQL editor, never
-- through the API. The company's supervisors can read the reason.
create table public.billing_overrides (
  company_id uuid primary key references public.companies (id) on delete cascade,
  reason text not null,
  until timestamptz,
  created_at timestamptz not null default now(),
  constraint billing_overrides_reason_check check (pg_catalog.char_length(pg_catalog.btrim(reason)) between 1 and 500)
);

-- Every Stripe event the webhook has handed over, MineMuster's or not, so an
-- event delivered twice is applied once. outcome says what was done with it:
-- 'applied', or the reason it changed nothing. No API role reads it.
create table public.stripe_events (
  id text primary key,
  type text not null,
  outcome text,
  received_at timestamptz not null default now()
);

create index stripe_events_received_at_idx on public.stripe_events (received_at);

-- ---- The contact form ------------------------------------------------------------------------------

-- What visitors to minemuster.com send through its contact form, cleaned and
-- checked by submit_contact_request. The owner reads it in the table editor
-- and sets handled once it is answered.
create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text not null,
  phone text,
  message text not null,
  created_at timestamptz not null default now(),
  handled boolean not null default false,

  constraint contact_requests_name_check check (pg_catalog.char_length(name) between 1 and 120),
  constraint contact_requests_company_check check (company is null or pg_catalog.char_length(company) between 1 and 160),
  constraint contact_requests_email_check check (pg_catalog.char_length(email) between 3 and 254),
  constraint contact_requests_phone_check check (phone is null or pg_catalog.char_length(phone) between 1 and 40),
  constraint contact_requests_message_check check (pg_catalog.char_length(message) between 1 and 4000)
);

-- The limits: messages from one email address in a day, and from everyone in
-- an hour.
create index contact_requests_email_idx on public.contact_requests (pg_catalog.lower(email), created_at);
create index contact_requests_created_at_idx on public.contact_requests (created_at);

-- Who has sent a message in the last hour, for the limit on each sender: a
-- keyed hash of the network address a message came from, never the address
-- itself. A row is kept for an hour, and the next message deletes it.
create table public.contact_senders (
  id uuid primary key default gen_random_uuid(),
  sender bytea not null,
  sent_at timestamptz not null default now()
);

create index contact_senders_sender_idx on public.contact_senders (sender, sent_at);
create index contact_senders_sent_at_idx on public.contact_senders (sent_at);

-- The key of those hashes, made at random here, once: without it an hour's
-- hashes cannot be turned back into addresses by trying every address.
create table public.contact_sender_key (
  one boolean primary key default true,
  key bytea not null,
  constraint contact_sender_key_one check (one)
);

insert into public.contact_sender_key (key)
values (pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8'));

-- ---- Who reads and writes them ----------------------------------------------------------------------

alter table public.billing_subscriptions enable row level security;
alter table public.billing_overrides enable row level security;
alter table public.stripe_events enable row level security;
alter table public.contact_requests enable row level security;
alter table public.contact_senders enable row level security;
alter table public.contact_sender_key enable row level security;

revoke all on table public.billing_subscriptions from public, anon, authenticated, service_role;
revoke all on table public.billing_overrides from public, anon, authenticated, service_role;
revoke all on table public.stripe_events from public, anon, authenticated, service_role;
revoke all on table public.contact_requests from public, anon, authenticated, service_role;
revoke all on table public.contact_senders from public, anon, authenticated, service_role;
revoke all on table public.contact_sender_key from public, anon, authenticated, service_role;

-- A company's supervisors read its subscriptions and its override, through
-- the policies below. The server key reads them too, and writes neither:
-- apply_stripe_event does, and the owner in the SQL editor. TRUNCATE went with
-- revoke all above, from the server key as well (as migration 20261116001500
-- does for the step-1 tables).
grant select on table public.billing_subscriptions to authenticated, service_role;
grant select on table public.billing_overrides to authenticated, service_role;
-- The server key may read what the contact form kept; anon and authenticated
-- may not, so a visitor reads nobody's message, their own included.
grant select on table public.contact_requests to service_role;
-- stripe_events, contact_senders and contact_sender_key: no API role at all.
-- apply_stripe_event keeps the first, submit_contact_request the other two.

-- As every policy here does (migration 20261116002300), each compares the
-- row's company with the caller's own companies, worked out once per
-- statement, and calls no function on the row.
create policy billing_subscriptions_select_supervisors
  on public.billing_subscriptions for select
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]));

create policy billing_overrides_select_supervisors
  on public.billing_overrides for select
  to authenticated
  using (company_id = any ((select public.supervisor_company_ids())::uuid[]));

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
      and c.relname in ('billing_subscriptions', 'billing_overrides', 'stripe_events', 'contact_requests', 'contact_senders', 'contact_sender_key')
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname, a.attnum
  loop
    execute pg_catalog.format('alter table %s alter column %I set statistics 0', col.tbl, col.attname);
  end loop;
end;
$$;

-- ---- Stripe's events -------------------------------------------------------------------------------

-- A time Stripe gives as Unix seconds, as a timestamptz. Null for anything
-- that is not a number of seconds between 1970 and the year 3000, so an odd
-- value never stops an event.
create function public.stripe_time(seconds jsonb)
returns timestamptz
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when pg_catalog.jsonb_typeof(seconds) = 'number' then
      case
        when seconds::numeric between 0 and 32503680000
        then pg_catalog.to_timestamp(seconds::numeric::double precision)
      end
  end
$$;

revoke all on function public.stripe_time(jsonb) from public, anon, authenticated, service_role;

-- Apply one Stripe event, already checked against Stripe's signature by the
-- webhook. For the server key only. Answers {applied: true, ...} when it
-- changed a subscription, and {applied: false, reason} when it did not:
--
--   duplicate        the event was handed over before
--   test_mode        an event from Stripe's test mode (livemode is not true):
--                    test cards never open a real company. Test against
--                    another Supabase project.
--   ignored_type     not a kind of event MineMuster uses
--   not_minemuster   another business's checkout or subscription
--   not_subscription a MineMuster checkout that is not for a subscription
--   no_company       a MineMuster checkout whose client_reference_id is not a
--                    company here
--   no_subscription  the event names no subscription id
--   already_linked   the subscription is already another company's
--   unknown_status   a status this migration does not know
--   no_time          a subscription event with no time of its own
--   stale            an older event than the one the subscription is at
--   ended            the subscription has ended in Stripe; it does not restart
--
-- It raises (22023) only for something that is not a Stripe event at all: not
-- a JSON object, or one with no id or type. Never for another business's
-- event, so the webhook answers Stripe 200 and Stripe stops sending it.
create function public.apply_stripe_event(p_event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  event_id text;
  event_type text;
  obj jsonb;
  answer jsonb;
  inserted integer;
  sub_id text;
  customer text;
  ref text;
  company uuid;
  linked uuid;
  sub_status text;
  event_time timestamptz;
  trial_end_at timestamptz;
  period_end_at timestamptz;
  cancels boolean;
  ours boolean;
  have_status text;
  have_event_at timestamptz;
  written integer;
begin
  if p_event is null or pg_catalog.jsonb_typeof(p_event) <> 'object' then
    raise exception using errcode = '22023', message = 'A Stripe event is a JSON object.';
  end if;
  if pg_catalog.jsonb_typeof(p_event -> 'id') is distinct from 'string'
     or pg_catalog.jsonb_typeof(p_event -> 'type') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'A Stripe event has an id and a type.';
  end if;
  event_id := p_event ->> 'id';
  event_type := p_event ->> 'type';
  if pg_catalog.char_length(event_id) not between 1 and 255 or event_id ~ '[\x01-\x1f\x7f-\x9f]'
     or pg_catalog.char_length(event_type) not between 1 and 255 or event_type ~ '[\x01-\x1f\x7f-\x9f]' then
    raise exception using errcode = '22023', message = 'A Stripe event has an id and a type.';
  end if;

  -- Seen before: applied once already, or set aside once already.
  insert into public.stripe_events (id, type) values (event_id, event_type)
  on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return pg_catalog.jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  obj := p_event -> 'data' -> 'object';
  if obj is not null and pg_catalog.jsonb_typeof(obj) <> 'object' then
    obj := null;
  end if;

  -- The subscription the object names: an id, or an expanded object with one.
  if event_type = 'checkout.session.completed' then
    sub_id := case pg_catalog.jsonb_typeof(obj -> 'subscription')
      when 'string' then obj ->> 'subscription'
      when 'object' then obj -> 'subscription' ->> 'id'
    end;
  else
    sub_id := case when pg_catalog.jsonb_typeof(obj -> 'id') = 'string' then obj ->> 'id' end;
  end if;
  if sub_id !~ '^[A-Za-z0-9_]{1,255}$' then
    sub_id := null;
  end if;
  customer := case pg_catalog.jsonb_typeof(obj -> 'customer')
    when 'string' then obj ->> 'customer'
    when 'object' then obj -> 'customer' ->> 'id'
  end;
  if customer !~ '^[A-Za-z0-9_]{1,255}$' then
    customer := null;
  end if;

  if (p_event -> 'livemode') is distinct from 'true'::jsonb then
    -- Stripe's test mode, whatever kind of event, is set aside before anything
    -- in it is read. (Every Stripe event says which mode it is from.)
    answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'test_mode');

  elsif event_type = 'checkout.session.completed' then
    if (obj -> 'metadata' ->> 'app') is distinct from 'minemuster' then
      answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'not_minemuster');
    elsif (obj ->> 'mode') is distinct from 'subscription' then
      answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'not_subscription');
    else
      ref := case when pg_catalog.jsonb_typeof(obj -> 'client_reference_id') = 'string' then obj ->> 'client_reference_id' end;
      if ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select c.id into company from public.companies c where c.id = ref::uuid;
      end if;
      if company is null then
        answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'no_company');
      elsif sub_id is null then
        answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'no_subscription');
      else
        -- The first link stands. The subscription's own events may already
        -- have made the row, with no company yet.
        insert into public.billing_subscriptions as b (subscription_id, company_id, customer_id)
        values (sub_id, company, customer)
        on conflict (subscription_id) do update
        set company_id = coalesce(b.company_id, excluded.company_id),
            customer_id = coalesce(b.customer_id, excluded.customer_id),
            updated_at = pg_catalog.now()
        where b.company_id is null or b.company_id = excluded.company_id
        returning b.company_id into linked;
        if linked is null then
          answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'already_linked');
        else
          answer := pg_catalog.jsonb_build_object(
            'applied', true, 'type', event_type, 'subscription_id', sub_id, 'company_id', linked);
        end if;
      end if;
    end if;

  elsif event_type in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') then
    ours := (obj -> 'metadata' ->> 'app') is not distinct from 'minemuster'
      or (sub_id is not null and exists (select 1 from public.billing_subscriptions s where s.subscription_id = sub_id));
    sub_status := case when pg_catalog.jsonb_typeof(obj -> 'status') = 'string' then obj ->> 'status' end;
    event_time := public.stripe_time(p_event -> 'created');
    if not ours then
      answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'not_minemuster');
    elsif sub_id is null then
      answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'no_subscription');
    elsif sub_status is null or sub_status not in (
      'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'
    ) then
      answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'unknown_status');
    elsif event_time is null then
      answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'no_time');
    else
      trial_end_at := public.stripe_time(obj -> 'trial_end');
      -- current_period_end is on the subscription in older Stripe API
      -- versions, and on each of its items in newer ones.
      period_end_at := coalesce(
        public.stripe_time(obj -> 'current_period_end'),
        public.stripe_time(obj -> 'items' -> 'data' -> 0 -> 'current_period_end')
      );
      cancels := case when pg_catalog.jsonb_typeof(obj -> 'cancel_at_period_end') = 'boolean'
                      then (obj -> 'cancel_at_period_end')::boolean else false end;

      -- Only an event no older than the one the subscription is at, and never
      -- one that would start an ended subscription again. The row is locked
      -- while this runs, so two events at once take turns.
      insert into public.billing_subscriptions as b
        (subscription_id, customer_id, status, trial_end, current_period_end, cancel_at_period_end, event_at)
      values (sub_id, customer, sub_status, trial_end_at, period_end_at, cancels, event_time)
      on conflict (subscription_id) do update
      set customer_id = coalesce(excluded.customer_id, b.customer_id),
          status = excluded.status,
          trial_end = excluded.trial_end,
          current_period_end = coalesce(excluded.current_period_end, b.current_period_end),
          cancel_at_period_end = excluded.cancel_at_period_end,
          event_at = excluded.event_at,
          updated_at = pg_catalog.now()
      where (b.event_at is null or b.event_at <= excluded.event_at)
        and (b.status is null
             or b.status not in ('canceled', 'incomplete_expired')
             or excluded.status in ('canceled', 'incomplete_expired'));
      get diagnostics written = row_count;

      if written = 1 then
        answer := pg_catalog.jsonb_build_object(
          'applied', true, 'type', event_type, 'subscription_id', sub_id, 'status', sub_status);
      else
        select s.status, s.event_at into have_status, have_event_at
        from public.billing_subscriptions s
        where s.subscription_id = sub_id;
        answer := pg_catalog.jsonb_build_object('applied', false, 'reason',
          case when have_event_at > event_time then 'stale' else 'ended' end);
      end if;
    end if;

  else
    answer := pg_catalog.jsonb_build_object('applied', false, 'reason', 'ignored_type');
  end if;

  update public.stripe_events e
  set outcome = case when (answer ->> 'applied')::boolean then 'applied' else answer ->> 'reason' end
  where e.id = event_id;

  return answer;
end;
$$;

revoke all on function public.apply_stripe_event(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_stripe_event(jsonb) to service_role;

-- The webhook's signing secret (whsec_...), from Supabase Vault, where the
-- owner keeps it under the name stripe_webhook_secret. For the server key
-- only: the webhook reads it here when its own STRIPE_WEBHOOK_SECRET is not
-- set. Null when it is not there, or the project has no Vault.
create function public.stripe_webhook_secret()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  secret text;
begin
  select s.decrypted_secret into secret
  from vault.decrypted_secrets s
  where s.name = 'stripe_webhook_secret'
  limit 1;
  return nullif(pg_catalog.btrim(secret), '');
exception
  when undefined_table or invalid_schema_name then
    return null;
end;
$$;

revoke all on function public.stripe_webhook_secret() from public, anon, authenticated, service_role;
grant execute on function public.stripe_webhook_secret() to service_role;

-- ---- Where a company stands ------------------------------------------------------------------------

-- Where a company's billing stands, from its subscriptions and its override.
-- No API role calls it: company_billing and company_has_access, below, decide
-- who may ask. Answers {access, status, trial_end, current_period_end,
-- cancel_at_period_end, running, had_trial}, where access is:
--
--   comped    a billing_overrides row with no until, or one still to come
--   active    a subscription is paid up
--   past_due  a charge failed and Stripe is trying the card again: still in
--   trial     the company's first free trial is running; or a checkout was
--             done in the last hour and its subscription's own status has not
--             come in yet (Checkout completes only once the card is taken, and
--             the next event sets the status, usually within seconds)
--   ended     every subscription has ended (canceled, unpaid, paused,
--             incomplete, incomplete_expired), or the only one still running
--             is a second free trial
--   none      no subscription, or only a checkout whose status never came in
--
-- A company has one free trial. A trialing subscription counts only when no
-- other subscription of the company that had a trial was made before it, so
-- starting a trial, cancelling it and starting another gives no second 14
-- days. (A company that has had its trial starts again on a payment link with
-- no trial: the dashboard's RESTART_LINK.)
--
-- The subscription it goes by, whose status and dates it gives (when the
-- company is comped too), is the first of: one that is active, one that is
-- past due, the first trial, a checkout of the last hour, a second trial; and
-- only when there is none of those, the newest (by event_at, then
-- updated_at). So a company with a running subscription is never shut out by
-- one that ended, and a checkout someone else made with the company's id
-- cannot change what a paying company is told.
--
--   running    how many of the company's subscriptions Stripe will charge
--              again: trialing, active or past_due and not cancelled, and a
--              checkout of the last hour. More than one means the company is
--              charged more than once a month.
--   had_trial  a subscription of the company has had a free trial, the one it
--              goes by included, so a new checkout would get no trial that
--              counts.
create function public.billing_standing(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  comped boolean;
  have boolean;
  sub_rank integer;
  sub_status text;
  sub_trial_end timestamptz;
  sub_period_end timestamptz;
  sub_cancels boolean;
  running integer;
  had_trial boolean;
  access text;
begin
  select exists (
    select 1 from public.billing_overrides o
    where o.company_id = p_company_id
      and (o.until is null or o.until > pg_catalog.now())
  ) into comped;

  select pg_catalog.count(*) filter (
           where (s.status in ('trialing', 'active', 'past_due') and not s.cancel_at_period_end)
              or (s.status is null and s.created_at > pg_catalog.now() - interval '1 hour')),
         coalesce(pg_catalog.bool_or(s.trial_end is not null or s.status = 'trialing'), false)
  into running, had_trial
  from public.billing_subscriptions s
  where s.company_id = p_company_id;

  select g.rank, g.status, g.trial_end, g.current_period_end, g.cancel_at_period_end
  into sub_rank, sub_status, sub_trial_end, sub_period_end, sub_cancels
  from (
    select s.subscription_id, s.status, s.trial_end, s.current_period_end, s.cancel_at_period_end,
           s.event_at, s.updated_at,
           case
             when s.status = 'active' then 1
             when s.status = 'past_due' then 2
             -- The first trial: no subscription of the company made before
             -- this one had a trial.
             when s.status = 'trialing' and not exists (
               select 1 from public.billing_subscriptions e
               where e.company_id = s.company_id
                 and e.subscription_id <> s.subscription_id
                 and (e.trial_end is not null or e.status = 'trialing')
                 and (e.created_at, e.subscription_id) < (s.created_at, s.subscription_id)
             ) then 3
             when s.status is null and s.created_at > pg_catalog.now() - interval '1 hour' then 4
             when s.status = 'trialing' then 5
             else 6
           end as rank
    from public.billing_subscriptions s
    where s.company_id = p_company_id
  ) g
  order by g.rank, g.event_at desc nulls last, g.updated_at desc, g.subscription_id
  limit 1;
  have := found;

  access := case
    when comped then 'comped'
    when not have then 'none'
    when sub_rank = 1 then 'active'
    when sub_rank = 2 then 'past_due'
    when sub_rank in (3, 4) then 'trial'
    -- Only checkouts whose subscription never said its status: as if none.
    when sub_status is null then 'none'
    else 'ended'
  end;

  return pg_catalog.jsonb_build_object(
    'access', access,
    'status', sub_status,
    'trial_end', sub_trial_end,
    'current_period_end', sub_period_end,
    'cancel_at_period_end', coalesce(sub_cancels, false),
    'running', coalesce(running, 0),
    'had_trial', coalesce(had_trial, false)
  );
end;
$$;

revoke all on function public.billing_standing(uuid) from public, anon, authenticated, service_role;

-- Whether a company has MineMuster, for its supervisors (the office dashboard
-- opens its supervisor pages by this). Anyone else is told there is no such
-- company, as every supervisor function says. The answer is billing_standing's.
create function public.company_billing(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;
  if p_company_id is null or not public.is_supervisor(p_company_id) then
    raise exception using errcode = 'P0002', message = 'No such company.';
  end if;
  return public.billing_standing(p_company_id);
end;
$$;

revoke all on function public.company_billing(uuid) from public, anon, authenticated, service_role;
grant execute on function public.company_billing(uuid) to authenticated;

-- Whether the company has MineMuster now: comped, in its trial, paid up, or
-- past due while Stripe tries the card again. What the server lets a
-- supervisor read goes by this (below). No API role calls it.
create function public.company_has_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select p_company_id is not null
    and (public.billing_standing(p_company_id) ->> 'access') in ('comped', 'trial', 'active', 'past_due');
$$;

revoke all on function public.company_has_access(uuid) from public, anon, authenticated, service_role;

-- ---- What a supervisor reads ------------------------------------------------------------------------

-- The companies whose records the caller may read: every company they are a
-- member of, but one where they are a supervisor only while it has MineMuster.
-- So the office dashboard's reads are what a company pays for, whatever the
-- dashboard's own code does. A member who is not a supervisor reads as before:
-- whether the crew's reads stop too is the owner's call (one line here), and
-- no phone reads records today. Sending is never stopped: push_records does
-- not look at billing, so a phone never loses a safety record.
--
-- For the policies below, which call it as the signed-in account, once per
-- statement. Like member_company_ids it never raises: no companies when nobody
-- is signed in.
create function public.records_open_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with supervised as (select public.supervisor_company_ids() as ids)
  select coalesce(pg_catalog.array_agg(m.id), '{}')
  from pg_catalog.unnest(public.member_company_ids()) as m (id), supervised
  where not (m.id = any (supervised.ids))
     or public.company_has_access(m.id);
$$;

revoke all on function public.records_open_company_ids() from public, anon, authenticated, service_role;
grant execute on function public.records_open_company_ids() to authenticated;

-- Restrictive: on top of what records_select_members and
-- record_history_select_members let a member read (migration
-- 20261117000200), a row is read only from those companies. Like every policy
-- here it compares the row's company with an array worked out once per
-- statement, and calls no function on the row.
create policy records_select_paid
  on public.records
  as restrictive
  for select
  to authenticated
  using (company_id = any ((select public.records_open_company_ids())::uuid[]));

create policy record_history_select_paid
  on public.record_history
  as restrictive
  for select
  to authenticated
  using (company_id = any ((select public.records_open_company_ids())::uuid[]));
-- ---- The contact form ------------------------------------------------------------------------------

-- Keep what a visitor sent from the contact form on minemuster.com. Anyone
-- may call it, signed in or not. Answers {ok: true}.
--
-- p_website is a field people never see: a form that fills it in is a bot,
-- and is answered {ok: true} with nothing kept. A field far over its limit is
-- turned back first, before anything is done with it, so a huge request costs
-- the database next to nothing (a refused call counts toward no limit, so it
-- could be sent again and again). Everything else is trimmed and cleaned of
-- control and invisible characters (the message keeps its line breaks and
-- tabs; the other fields are one line, with runs of spaces closed up), then
-- checked. A field that does not pass raises 22023, with a message the site
-- can show as it is and a hint the site can go by:
--
--   name_missing, name_too_long (120), email_invalid (254), message_missing,
--   message_too_long (4000), company_too_long (160), phone_too_long (40)
--
-- The limits, so that one sender cannot shut the form for everyone, and the
-- table cannot be flooded:
--
--   * 3 messages from one email address (whatever its capitals) in 24 hours;
--   * 5 from one sender in an hour: one network address, the first entry of
--     X-Forwarded-For, as Supabase documents the client's address. Only a
--     keyed hash of it is kept (contact_senders), and only for that hour;
--   * 100 from everyone in an hour, a backstop for storage alone.
--
-- Past any of them it raises PT429 (which PostgREST answers with HTTP 429),
-- hint too_many: "Too many messages. Try again later." Calls take turns, so
-- two at once cannot both slip under a limit.
create function public.submit_contact_request(
  p_name text,
  p_company text,
  p_email text,
  p_phone text,
  p_message text,
  p_website text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  -- Control characters, line and paragraph separators: a space on one line.
  breaks constant text := '[\x01-\x1f\x7f-\x9f\u2028\u2029]';
  -- Characters that show nothing, taken out: Unicode's default-ignorable
  -- characters and the other format characters, as names on the roster are
  -- checked (migration 20261116001800): the soft hyphen, zero-width spaces and
  -- joiners, direction marks, overrides and isolates, the word joiner and the
  -- invisible operators, variation selectors, the Hangul and braille fillers,
  -- the Mongolian vowel separator, interlinear annotations, the byte order
  -- mark, tag characters, and the like.
  hidden constant text := '[\x00ad\x034f\x0600-\x0605\x061c\x06dd\x070f\x0890\x0891\x08e2\x115f\x1160\x17b4\x17b5\x180b-\x180f\x200b-\x200f\x202a-\x202e\x2060-\x206f\x2800\x3164\xfe00-\xfe0f\xfeff\xffa0\xfff0-\xfffb\x110bd\x110cd\x13430-\x1343f\x1bca0-\x1bca3\x1d173-\x1d17a\xe0000-\xe0fff]';
  -- Every kind of space, the no-break space and the ideographic space among
  -- them (as migration 20261116000100 reads names).
  spaces constant text := '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+';
  v_name text;
  v_company text;
  v_email text;
  v_phone text;
  v_message text;
  headers jsonb;
  address text;
  v_sender bytea;
begin
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('ok', true);
  end if;

  -- Far over a limit, in bytes, before any cleaning: a few times what the
  -- longest field that passes can take, invisible characters and all.
  if pg_catalog.octet_length(p_name) > 1000 then
    raise exception using errcode = '22023', message = 'Keep your name to 120 characters.', hint = 'name_too_long';
  elsif pg_catalog.octet_length(p_email) > 1500 then
    raise exception using errcode = '22023', message = 'Type an email address we can write back to.', hint = 'email_invalid';
  elsif pg_catalog.octet_length(p_message) > 20000 then
    raise exception using errcode = '22023', message = 'Keep the message to 4,000 characters.', hint = 'message_too_long';
  elsif pg_catalog.octet_length(p_company) > 1000 then
    raise exception using errcode = '22023', message = 'Keep the company name to 160 characters.', hint = 'company_too_long';
  elsif pg_catalog.octet_length(p_phone) > 500 then
    raise exception using errcode = '22023', message = 'Keep the phone number to 40 characters.', hint = 'phone_too_long';
  end if;

  v_name := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
    coalesce(p_name, ''), hidden, '', 'g'), breaks, ' ', 'g'), spaces, ' ', 'g'));
  v_company := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
    coalesce(p_company, ''), hidden, '', 'g'), breaks, ' ', 'g'), spaces, ' ', 'g'));
  v_email := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
    coalesce(p_email, ''), hidden, '', 'g'), breaks, ' ', 'g'), spaces, ' ', 'g'));
  v_phone := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
    coalesce(p_phone, ''), hidden, '', 'g'), breaks, ' ', 'g'), spaces, ' ', 'g'));
  -- The message keeps its lines: every kind of line break becomes one, and
  -- other control characters but the tab are taken out.
  v_message := pg_catalog.regexp_replace(coalesce(p_message, ''), '\r\n?|[\u2028\u2029]', pg_catalog.chr(10), 'g');
  v_message := pg_catalog.regexp_replace(v_message, '[\x01-\x08\x0b-\x1f\x7f-\x9f]', '', 'g');
  v_message := pg_catalog.regexp_replace(v_message, hidden, '', 'g');
  v_message := pg_catalog.regexp_replace(v_message, '^' || spaces || '|' || spaces || '$', '', 'g');

  if v_name = '' then
    raise exception using errcode = '22023', message = 'Type your name.', hint = 'name_missing';
  elsif pg_catalog.char_length(v_name) > 120 then
    raise exception using errcode = '22023', message = 'Keep your name to 120 characters.', hint = 'name_too_long';
  end if;
  if pg_catalog.char_length(v_email) > 254
     or v_email !~ '^[^@ ]{1,64}@[^@ .]+(\.[^@ .]+)+$' then
    raise exception using errcode = '22023', message = 'Type an email address we can write back to.', hint = 'email_invalid';
  end if;
  if v_message = '' then
    raise exception using errcode = '22023', message = 'Type a message.', hint = 'message_missing';
  elsif pg_catalog.char_length(v_message) > 4000 then
    raise exception using errcode = '22023', message = 'Keep the message to 4,000 characters.', hint = 'message_too_long';
  end if;
  if pg_catalog.char_length(v_company) > 160 then
    raise exception using errcode = '22023', message = 'Keep the company name to 160 characters.', hint = 'company_too_long';
  end if;
  if pg_catalog.char_length(v_phone) > 40 then
    raise exception using errcode = '22023', message = 'Keep the phone number to 40 characters.', hint = 'phone_too_long';
  end if;

  -- Who sent it: the address PostgREST was handed in X-Forwarded-For (its
  -- first entry), kept only as a hash with this server's own key. None when
  -- the call did not come through the API, as from the SQL editor, or the
  -- header does not hold an address; then only the other limits apply.
  begin
    headers := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  exception
    when invalid_text_representation then
      headers := null;
  end;
  if pg_catalog.jsonb_typeof(headers) = 'object' then
    address := pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(headers ->> 'x-forwarded-for', ',', 1)));
  end if;
  if address ~ '^[0-9a-f:.]{2,45}$' then
    select pg_catalog.sha256(k.key || pg_catalog.convert_to(address, 'UTF8')) into v_sender
    from public.contact_sender_key k;
  end if;

  -- One call at a time from here to the commit, so the counts below see every
  -- message kept before this one.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.contact_requests', 0));

  -- What is older than the hour the sender limit looks at is not kept.
  delete from public.contact_senders s where s.sent_at <= pg_catalog.now() - interval '1 hour';

  if (select pg_catalog.count(*) from public.contact_requests c
      where pg_catalog.lower(c.email) = pg_catalog.lower(v_email)
        and c.created_at > pg_catalog.now() - interval '24 hours') >= 3
     or (v_sender is not null
         and (select pg_catalog.count(*) from public.contact_senders s where s.sender = v_sender) >= 5)
     or (select pg_catalog.count(*) from public.contact_requests c
         where c.created_at > pg_catalog.now() - interval '1 hour') >= 100 then
    raise exception using errcode = 'PT429', message = 'Too many messages. Try again later.', hint = 'too_many';
  end if;

  insert into public.contact_requests (name, company, email, phone, message)
  values (v_name, nullif(v_company, ''), v_email, nullif(v_phone, ''), v_message);
  if v_sender is not null then
    insert into public.contact_senders (sender) values (v_sender);
  end if;

  return pg_catalog.jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.submit_contact_request(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.submit_contact_request(text, text, text, text, text, text) to anon, authenticated;
