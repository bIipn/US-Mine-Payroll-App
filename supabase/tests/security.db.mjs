// The database's own guarantees, read from the catalog: every function
// searches pg_catalog first and the temporary schema last, EXECUTE goes only
// to the roles that need it, every refusal is a code PostgREST answers with a
// 4xx, row level security is on for every table, each
// role holds exactly the privileges it should, no column keeps planner
// statistics, and the migrations leave what Supabase provides alone.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { migrationFiles, MIGRATIONS, startDatabase } from './harness.mjs';

let db;
before(async () => {
  db = await startDatabase();
});
after(async () => {
  await db?.close();
});

const ROLES = ['anon', 'authenticated', 'service_role'];

// Who may call each function in schema public. Everything else is private.
const CALLABLE_BY = {
  company_by_code: ['anon', 'authenticated'],
  create_company: ['authenticated'],
  join_company: ['authenticated'],
  approve_join_request: ['authenticated'],
  deny_join_request: ['authenticated'],
  rotate_join_code: ['authenticated'],
  release_roster_claim: ['authenticated'],
  lift_join_bar: ['authenticated'],
  my_join_requests: ['authenticated'],
  my_companies: ['authenticated'],
  push_records: ['authenticated'],
  is_last_supervisor: ['service_role'],
  step_down_everywhere: ['service_role'],
  // Billing (migration 20261117000500): the webhook applies Stripe's events and
  // reads its signing secret with the server key; supervisors ask where their
  // company stands; anyone may send the website's contact form.
  apply_stripe_event: ['service_role'],
  stripe_webhook_secret: ['service_role'],
  company_billing: ['authenticated'],
  submit_contact_request: ['anon', 'authenticated'],
  is_member: ['authenticated'],
  is_supervisor: ['authenticated'],
  // The row level security policies call these as the signed-in account.
  member_company_ids: ['authenticated'],
  supervisor_company_ids: ['authenticated'],
  // The companies whose records the caller reads: a supervisor's only while
  // the company has MineMuster (migration 20261117000500).
  records_open_company_ids: ['authenticated'],
};

const SECURITY_DEFINER = [
  'apply_stripe_event',
  'approve_join_request',
  'billing_standing',
  'companies_before_write',
  'company_billing',
  'company_by_code',
  'company_has_access',
  'create_company',
  'deny_join_request',
  'is_last_supervisor',
  'is_member',
  'is_supervisor',
  'join_company',
  'lift_join_bar',
  'member_company_ids',
  'my_companies',
  'my_join_requests',
  'push_records',
  'records_open_company_ids',
  'release_roster_claim',
  'roster_after_reactivate',
  'roster_before_delete',
  'roster_before_write',
  'roster_keeps_a_supervisor',
  'roster_names_look_apart',
  'rotate_join_code',
  'step_down_everywhere',
  'stripe_webhook_secret',
  'submit_contact_request',
  'supervisor_company_ids',
];

const TABLES = [
  'billing_overrides',
  'billing_subscriptions',
  'companies',
  'company_supervisor_guard',
  'contact_requests',
  'contact_sender_key',
  'contact_senders',
  'join_holds',
  'join_requests',
  'notifications',
  'record_counters',
  'record_history',
  'record_usage',
  'records',
  'roster',
  'stripe_events',
];

// What the authenticated role may do: whole-table privileges, and the columns it may insert and update.
const AUTHENTICATED = {
  companies: { table: ['SELECT'], insert: [], update: ['name', 'state', 'timezone', 'logo_path', 'pay_period'] },
  roster: {
    table: ['SELECT', 'DELETE'],
    insert: ['company_id', 'first_name', 'last_name', 'title', 'role', 'active'],
    update: ['first_name', 'last_name', 'title', 'role', 'active'],
  },
  join_requests: { table: ['SELECT'], insert: [], update: [] },
  notifications: { table: ['SELECT'], insert: [], update: ['read_at'] },
  // Kept by the functions and triggers only.
  company_supervisor_guard: { table: [], insert: [], update: [] },
  join_holds: { table: [], insert: [], update: [] },
  // Written by push_records only, and read through their policies.
  records: { table: ['SELECT'], insert: [], update: [] },
  record_history: { table: ['SELECT'], insert: [], update: [] },
  // push_records' own counts: each company's seq, each account's sends today.
  record_counters: { table: [], insert: [], update: [] },
  record_usage: { table: [], insert: [], update: [] },
  // Billing: a company's supervisors read its own rows; only apply_stripe_event
  // and the owner in the SQL editor write them.
  billing_subscriptions: { table: ['SELECT'], insert: [], update: [] },
  billing_overrides: { table: ['SELECT'], insert: [], update: [] },
  // Kept by apply_stripe_event and submit_contact_request; no API role reads them.
  stripe_events: { table: [], insert: [], update: [] },
  contact_requests: { table: [], insert: [], update: [] },
  // The contact form's limit on each sender, kept by submit_contact_request alone.
  contact_senders: { table: [], insert: [], update: [] },
  contact_sender_key: { table: [], insert: [], update: [] },
};
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

async function publicFunctions() {
  return db.adminRows(`
    select p.oid, p.proname as name, p.prosecdef as definer, coalesce(p.proconfig, '{}') as config,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      -- An extension someone put in public is not the migrations' to judge.
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    order by p.proname`);
}

describe('functions', () => {
  it('every security definer function searches pg_catalog first and the temporary schema last', async () => {
    const functions = await publicFunctions();
    const definers = functions.filter((f) => f.definer);
    assert.deepEqual(definers.map((f) => f.name).sort(), SECURITY_DEFINER);
    for (const fn of definers) assert.ok(fn.config.includes('search_path=pg_catalog, pg_temp'), `${fn.name}: ${fn.config}`);
  });

  it('so does every other function, private helpers included', async () => {
    for (const fn of await publicFunctions()) assert.ok(fn.config.includes('search_path=pg_catalog, pg_temp'), `${fn.name}: ${fn.config}`);
  });

  it('EXECUTE is taken from PUBLIC, and given only to the roles that need it', async () => {
    const functions = await publicFunctions();
    assert.ok(functions.length >= Object.keys(CALLABLE_BY).length + 8);
    assert.equal(new Set(functions.map((f) => f.name)).size, functions.length, 'no function is overloaded');
    for (const fn of functions) {
      assert.equal(fn.public_can_execute, false, `PUBLIC can execute ${fn.name}`);
      const callers = [];
      for (const role of ROLES) {
        const [{ allowed }] = await db.adminRows("select has_function_privilege($1, $2::oid, 'execute') as allowed", [role, fn.oid]);
        if (allowed) callers.push(role);
      }
      assert.deepEqual(callers, CALLABLE_BY[fn.name] ?? [], fn.name);
    }
  });
});

// ---- Refusals -----------------------------------------------------------------------------------
//
// PostgREST answers the SQLSTATE a function raises with an HTTP status: a PTnnn code with nnn, 42501
// with 401 or 403, 22023 and 23514 with 400, and P0002, 55000 and the rest of the classes P0 and 55
// with 500, which tells the caller, and a scanner, that the server failed when it only said no. So
// every refusal a function makes on purpose is a code it answers with a 4xx.
const ANSWERED_WITH_4XX = { 42501: '401 or 403', 22023: '400', 23514: '400', PT404: '404', PT409: '409', PT429: '429' };
// Not a refusal: two push_records calls overlapped at REPEATABLE READ or SERIALIZABLE, and the second
// is told to try again (supabase/README.md, "When a function refuses").
const TRY_AGAIN = { push_records: '40001' };

// "Not found, or not the caller's" is PT404 and "not in a state to do that" PT409 (P0002 and 55000
// before migration 20261117000600), each with the words it had, in the order the function raises them.
const NOT_FOUND = 'PT404';
const WRONG_STATE = 'PT409';
const NO_SUCH_REQUEST = [NOT_FOUND, 'No such join request.'];
const ALREADY_DECIDED = [WRONG_STATE, 'That join request has already been decided.'];
const NOT_FOUND_OR_WRONG_STATE = {
  approve_join_request: [
    NO_SUCH_REQUEST,
    NO_SUCH_REQUEST,
    ALREADY_DECIDED,
    [WRONG_STATE, 'That person is already on the roster.', 'Deny the request to close it.'],
    [NOT_FOUND, 'No such roster row.'],
    [WRONG_STATE, 'That roster row is not active.'],
    [WRONG_STATE, 'That roster row is already claimed.', 'Approve with replace_claim to hand it to this person in one step, or release it first.'],
  ],
  company_billing: [[NOT_FOUND, 'No such company.']],
  deny_join_request: [NO_SUCH_REQUEST, NO_SUCH_REQUEST, ALREADY_DECIDED],
  lift_join_bar: [NO_SUCH_REQUEST],
  push_records: [[NOT_FOUND, 'No such company.']],
  release_roster_claim: [[NOT_FOUND, 'No such roster row.']],
  roster_before_write: [[WRONG_STATE, 'That roster row is already claimed by another account.', 'A supervisor can release it first.']],
  rotate_join_code: [[NOT_FOUND, 'No such company.']],
};

/** Every function of the migrations in schema public, with its source. */
async function publicSources() {
  return db.adminRows(`
    select p.proname as name, p.prosrc as src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    order by p.proname`);
}

const LITERAL = /^'(?:[^']|'')*'$/;
const unquote = (literal) => (literal && LITERAL.test(literal) ? literal.slice(1, -1).replaceAll("''", "'") : literal);

/** Each `raise exception using ...;` in a function's source: its errcode, message and hint, as written. */
function raisesOf(src) {
  return [...src.matchAll(/raise\s+exception\s+using\s+((?:'(?:[^']|'')*'|[^';])*);/gi)].map(([, clauses]) => {
    const clause = (name) => new RegExp(`\\b${name}\\s*=\\s*((?:'(?:[^']|'')*'|[^',])+)`, 'i').exec(clauses)?.[1].trim() ?? null;
    return { code: unquote(clause('errcode')), message: clause('message'), hint: clause('hint'), text: clauses.replace(/\s+/g, ' ').trim() };
  });
}

describe('refusals', () => {
  it('are each a code PostgREST answers with a 4xx, never one it answers with a 5xx', async () => {
    let raises = 0;
    for (const fn of await publicSources()) {
      for (const raise of raisesOf(fn.src)) {
        raises += 1;
        if (raise.code === TRY_AGAIN[fn.name]) continue;
        assert.ok(Object.hasOwn(ANSWERED_WITH_4XX, raise.code), `${fn.name} raises ${raise.code}, which PostgREST does not answer with a 4xx: ${raise.text}`);
      }
    }
    assert.ok(raises >= 70, `only ${raises} raises were read: the reader has missed some`);
  });

  it('keep their words: not found is PT404 and not in a state to do that is PT409', async () => {
    const found = {};
    for (const fn of await publicSources()) {
      const these = raisesOf(fn.src).filter((raise) => raise.code === NOT_FOUND || raise.code === WRONG_STATE);
      if (these.length) found[fn.name] = these.map((raise) => [raise.code, unquote(raise.message), ...(raise.hint ? [unquote(raise.hint)] : [])]);
    }
    assert.deepEqual(found, NOT_FOUND_OR_WRONG_STATE);
  });

  it('with a PT code, have a message that is a constant on one line: PostgREST writes it into the HTTP status line', async () => {
    let checked = 0;
    for (const fn of await publicSources()) {
      for (const raise of raisesOf(fn.src).filter((one) => /^PT/.test(one.code ?? ''))) {
        checked += 1;
        // Printable ASCII only: a line break in it would end the status line and start a header of the caller's choosing.
        assert.match(raise.message ?? '', /^'(?:[\x20-\x26\x28-\x7e]|'')+'$/, `${fn.name}: ${raise.text}`);
      }
    }
    assert.ok(checked >= 17, `only ${checked} PT codes were read`);
  });
});

describe('tables', () => {
  it('row level security is on for every table, and every policy is for signed-in accounts only', async () => {
    const tables = await db.adminRows(`
      select c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`);
    assert.deepEqual(tables.map((t) => t.name), TABLES);
    for (const table of tables) assert.equal(table.rls, true, table.name);

    const policies = await db.adminRows("select tablename, policyname, roles::text[] as roles from pg_policies where schemaname = 'public'");
    assert.ok(policies.length >= 9);
    for (const policy of policies) assert.deepEqual(policy.roles, ['authenticated'], policy.policyname);
    // Writes through the API are allowed only where a policy says who may make them.
    const commands = new Set((await db.adminRows("select tablename || ' ' || cmd as c from pg_policies where schemaname = 'public'")).map((p) => p.c));
    assert.deepEqual([...commands].sort(), [
      'billing_overrides SELECT',
      'billing_subscriptions SELECT',
      'companies SELECT',
      'companies UPDATE',
      'join_requests SELECT',
      'notifications SELECT',
      'notifications UPDATE',
      'record_history SELECT',
      'records SELECT',
      'roster DELETE',
      'roster INSERT',
      'roster SELECT',
      'roster UPDATE',
    ]);
  });

  it('anon holds no privilege on any table or column', async () => {
    for (const table of TABLES) {
      for (const privilege of TABLE_PRIVILEGES) {
        const [{ has }] = await db.adminRows('select has_table_privilege($1, $2, $3) as has', ['anon', `public.${table}`, privilege]);
        assert.equal(has, false, `anon ${privilege} on ${table}`);
      }
      const [{ any }] = await db.adminRows("select has_any_column_privilege('anon', $1, 'SELECT, INSERT, UPDATE, REFERENCES') as any", [`public.${table}`]);
      assert.equal(any, false, `anon has a column privilege on ${table}`);
    }
  });

  it('no column keeps planner statistics, so an estimate says nothing about rows the caller cannot read', async () => {
    const columns = await db.adminRows(`
      select c.relname as tbl, a.attname as col, a.attstattarget as target
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      order by 1, a.attnum`);
    assert.deepEqual([...new Set(columns.map((c) => c.tbl))], TABLES);
    for (const c of columns) assert.equal(c.target, 0, `${c.tbl}.${c.col} keeps statistics (target ${c.target})`);
  });

  it('authenticated holds exactly the privileges it should, down to the column', async () => {
    for (const [table, expected] of Object.entries(AUTHENTICATED)) {
      for (const privilege of TABLE_PRIVILEGES) {
        const [{ has }] = await db.adminRows('select has_table_privilege($1, $2, $3) as has', ['authenticated', `public.${table}`, privilege]);
        assert.equal(has, expected.table.includes(privilege), `authenticated ${privilege} on ${table}`);
      }
      const columns = await db.adminRows(
        "select attname as name from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum",
        [`public.${table}`],
      );
      for (const { name } of columns) {
        for (const [privilege, allowed] of [['INSERT', expected.insert], ['UPDATE', expected.update]]) {
          const [{ has }] = await db.adminRows('select has_column_privilege($1, $2, $3, $4) as has', ['authenticated', `public.${table}`, name, privilege]);
          assert.equal(has, allowed.includes(name), `authenticated ${privilege} on ${table}.${name}`);
        }
      }
    }
  });
});

describe('what Supabase provides', () => {
  it('is left as it was: the auth schema, its users table and auth.uid(), and the roles', async () => {
    const authObjects = await db.adminRows(`
      select 'relation ' || c.relname as object from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth'
      union all
      select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth'
      order by 1`);
    assert.deepEqual(authObjects.map((o) => o.object), ['function jwt', 'function uid', 'relation users', 'relation users_pkey']);
    const columns = await db.adminRows("select attname from pg_attribute where attrelid = 'auth.users'::regclass and attnum > 0 and not attisdropped order by attnum");
    assert.deepEqual(columns.map((c) => c.attname), ['id', 'email', 'deleted_at', 'banned_until']);
    const triggers = await db.adminRows("select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal");
    assert.deepEqual(triggers, []);
    const [uid] = await db.adminRows("select prosrc, prosecdef from pg_proc where oid = 'auth.uid'::regproc");
    assert.match(uid.prosrc, /request\.jwt\.claim\.sub/);
    assert.equal(uid.prosecdef, false);

    const roles = await db.adminRows(`
      select rolname, rolsuper, rolinherit, rolcanlogin, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by rolname`);
    assert.deepEqual(roles, [
      { rolname: 'anon', rolsuper: false, rolinherit: false, rolcanlogin: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
      { rolname: 'authenticated', rolsuper: false, rolinherit: false, rolcanlogin: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
      { rolname: 'service_role', rolsuper: false, rolinherit: false, rolcanlogin: false, rolbypassrls: true, rolcreaterole: false, rolcreatedb: false },
    ]);
    const memberships = await db.adminRows("select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname in ('anon', 'authenticated', 'service_role')");
    assert.equal(memberships[0].n, 0);
  });

  it('is never created, changed or dropped by a migration, and no migration needs an extension', async () => {
    const forbidden = [
      [/\b(create|alter|drop)\s+(role|user|group)\b/i, 'a role'],
      [/\b(create|alter|drop)\s+schema\b/i, 'a schema'],
      [/\b(create|alter|drop)\s+extension\b/i, 'an extension'],
      [/\balter\s+default\s+privileges\b/i, 'default privileges'],
      [/\b(create|alter|drop)\s+(or\s+replace\s+)?(table|function|view|trigger|index|type|policy|sequence)\s+(if\s+(not\s+)?exists\s+)?auth\./i, 'an auth object'],
      [/\b(alter|drop)\s+function\s+auth\./i, 'auth.uid()'],
      [/\bon\s+(table\s+|function\s+|schema\s+)?auth\b[.\s]/i, 'a grant, policy or trigger on auth'],
      // Vault is only ever read, by stripe_webhook_secret.
      [/\b(create|alter|drop)\s+(or\s+replace\s+)?(table|function|view|trigger|index|type|policy|sequence)\s+(if\s+(not\s+)?exists\s+)?vault\./i, 'a Vault object'],
      [/\bon\s+(table\s+|function\s+|schema\s+|all\s+tables\s+in\s+schema\s+)?vault\b[.\s]/i, 'a grant, policy or trigger on Vault'],
      [/\b(insert\s+into|update|delete\s+from)\s+vault\./i, 'a write to Vault'],
    ];
    for (const name of await migrationFiles()) {
      const sql = (await readFile(new URL(name, MIGRATIONS), 'utf8')).replace(/--.*$/gm, '');
      for (const [pattern, what] of forbidden) assert.doesNotMatch(sql, pattern, `${name} touches ${what}`);
    }
  });
});

describe('the migration files', () => {
  it('are named by time and applied in that order, one name each', async () => {
    const names = await migrationFiles();
    assert.ok(names.length >= 10);
    for (const name of names) assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/);
    const stamps = names.map((name) => name.slice(0, 14));
    assert.equal(new Set(stamps).size, stamps.length);
    assert.deepEqual([...stamps].sort(), stamps);
  });

  it('are plain ASCII, so no invisible character hides in a pattern', async () => {
    for (const name of await migrationFiles()) {
      const sql = await readFile(new URL(name, MIGRATIONS), 'utf8');
      assert.doesNotMatch(sql, /[^\x09\x0a\x0d\x20-\x7e]/, name);
    }
  });
});
