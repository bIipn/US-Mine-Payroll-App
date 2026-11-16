-- MineMuster, step 1 hardening: bounds on a company's settings.
--
-- This migration is new; it never edits an applied one. Every company setting
-- had a bound but two:
--
--  * pay_period only had to be a JSON object, so a supervisor could store
--    megabytes, and every member downloads it with each read of the company.
--    It is now held to 16 KiB as text, far more than a pay schedule needs.
--  * logo_path took any text: a path that climbs out of the company's own
--    storage ("../other-company/logo"), one that starts at the root, or one
--    with a bidi override or another invisible character in it. Nothing reads
--    it yet; once storage or an Edge Function resolves it with a privileged
--    key, it must be a file in the company's own folder. It now refuses a ".."
--    segment, a leading "/", a backslash and the characters has_hidden_characters
--    finds. Storage should still build the full path from the company's id.
--
-- As for roster names, the name and logo checks run when that setting is
-- written, so a rule made stricter later never blocks other changes to a
-- company written before it.

alter table public.companies add constraint companies_pay_period_size
  check (pay_period is null or pg_catalog.octet_length(pay_period::text) <= 16384);

create or replace function public.companies_before_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  name_written boolean := true;
  logo_written boolean := true;
begin
  if tg_op = 'UPDATE' then
    name_written := new.name is distinct from old.name;
    logo_written := new.logo_path is distinct from old.logo_path;
  end if;

  new.name := public.clean_text(new.name);
  new.state := pg_catalog.upper(public.clean_text(new.state));
  new.timezone := public.clean_text(new.timezone);
  new.logo_path := nullif(public.clean_text(new.logo_path), '');

  if name_written and public.has_hidden_characters(new.name) then
    raise exception using
      errcode = '22023',
      message = 'A name cannot hold control or invisible characters.';
  end if;

  if logo_written and new.logo_path is not null and (
    public.has_hidden_characters(new.logo_path)
    or new.logo_path ~ '(^|/)\.\.(/|$)'
    or new.logo_path ~ '^/'
    or pg_catalog.strpos(new.logo_path, pg_catalog.chr(92)) > 0
  ) then
    raise exception using
      errcode = '22023',
      message = 'A logo path names a file in the company''s own storage: no "..", no leading "/", no backslash and no hidden characters.',
      hint = 'Use a path such as logos/logo.png.';
  end if;

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

-- Company names already stored are composed too (clean_text composes since
-- migration 20261116001800). Only rows whose name changes are written.
update public.companies c
set name = c.name
where c.name <> pg_catalog.normalize(c.name, 'NFC');
