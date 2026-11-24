-- MineMuster, step 1 hardening: the pay period's size is checked without
-- writing it out as text first.
--
-- This migration is new; it never edits an applied one. companies_pay_period_size
-- (migration 20261116001900) held pay_period to 16 KiB by writing it out as
-- text. jsonb keeps a number such as 1e131071 in a few bytes, and its text is
-- 131,072 characters, so a supervisor of any company (and anyone can start
-- one) could send a few kilobytes of such numbers and make the check build a
-- gigabyte before it refused them. The check now runs in three steps, in this
-- order: at most 64 KiB as stored, no number a phone or browser sends
-- (JSON.stringify writes nothing past +-1.8e308, and nothing nearer zero than
-- 5e-324), and only then at most 16 KiB as text. The same bound guards the
-- records (migration 20261117000100).

alter table public.companies drop constraint companies_pay_period_size;

alter table public.companies add constraint companies_pay_period_size check (
  pay_period is null
  or case
    when pg_catalog.pg_column_size(pay_period) > 65536 then false
    when pg_catalog.jsonb_path_exists(pay_period, 'strict $.** ? (@.type() == "number" && (@ > 1.8e308 || @ < -1.8e308 || (@ != 0 && @ < 4.9e-324 && @ > -4.9e-324)))') then false
    else pg_catalog.octet_length(pay_period::text) <= 16384
  end
);
