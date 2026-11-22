// The database's own guarantees, read from the catalog: every function
// searches pg_catalog first and the temporary schema last, EXECUTE goes only
// to the roles that need it, every raise in a function, whatever its shape, is
// a code PostgREST answers with a 4xx, row level security is on for every table, each
// role holds exactly the privileges it should, no column keeps planner
// statistics, and the migrations leave what Supabase provides alone.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { errorOf, migrationFiles, MIGRATIONS, startDatabase } from './harness.mjs';

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
  // Signed in only (migration 20261122000100): before anyone is signed in, the app looks a code up through
  // the crew-auth function, under its limit on tries (crew_lookup).
  company_by_code: ['authenticated'],
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
  // The phones read the company's settings, roster, fleet and area sheets (migration 20261120000100).
  read_shared_records: ['authenticated'],
  // Deleting an account (migration 20261120000200): what deleting it means in each of the caller's
  // companies, and a last supervisor closing a company nobody else can take over. Neither takes an
  // account id: the delete-account function asks them with the person's own token.
  account_deletion_check: ['authenticated'],
  close_company: ['authenticated'],
  is_last_supervisor: ['service_role'],
  step_down_everywhere: ['service_role'],
  // Billing (migration 20261117000500): the webhook applies Stripe's events and
  // reads its signing secret with the server key; supervisors ask where their
  // company stands; anyone may send the website's contact form.
  apply_stripe_event: ['service_role'],
  stripe_webhook_secret: ['service_role'],
  company_billing: ['authenticated'],
  submit_contact_request: ['anon', 'authenticated'],
  // Crew passcodes (migration 20261122000100): the server key keeps one. Checking one, the passcode
  // rule and the sign-in password are for the sign-in functions inside the database alone.
  crew_keep_passcode: ['service_role'],
  // The crew-auth function's checks, before it talks to Supabase Auth: the company a code is for, whether a
  // sign-up may go ahead, a sign-in by name and passcode, and the passcode of the account signed in, for
  // deleting it. The helpers they share (crew_try_counted, crew_find_person) are theirs alone.
  crew_lookup: ['service_role'],
  crew_sign_up_check: ['service_role'],
  crew_sign_in_check: ['service_role'],
  crew_confirm_check: ['service_role'],
  // A reset with a supervisor's reset code, checked by crew-auth as the other checks are.
  crew_reset_check: ['service_role'],
  // A supervisor's side of passcodes, with the supervisor's own token: a reset code for the passcode account
  // on a row, and that account, which the supervisor-tools function deletes with Supabase Auth. The helper
  // they share (crew_account_on_row) is theirs alone.
  make_passcode_reset_code: ['authenticated'],
  crew_sign_in_to_delete: ['authenticated'],
  // Supervisor invitations (migration 20261122000200): a supervisor invites, sends again and cancels, and reads the
  // roster's sign-ins, with their own token; the invited person lists theirs and accepts one. The server key alone
  // asks whether an address has an account, so supervisor-tools asks Supabase Auth to send an invite email only to a
  // new one. The helpers they share (email_key, confirmed_email_of, row_open_to_invitation) are theirs alone.
  invite_supervisor: ['authenticated'],
  resend_supervisor_invitation: ['authenticated'],
  cancel_supervisor_invitation: ['authenticated'],
  my_supervisor_invitations: ['authenticated'],
  accept_supervisor_invitation: ['authenticated'],
  roster_sign_ins: ['authenticated'],
  account_for_email: ['service_role'],
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
  'accept_supervisor_invitation',
  'account_deletion_check',
  'account_for_email',
  'apply_stripe_event',
  'approve_join_request',
  'billing_standing',
  'cancel_supervisor_invitation',
  'close_company',
  'companies_before_write',
  'company_billing',
  'company_by_code',
  'company_has_access',
  'create_company',
  'crew_check_passcode',
  'crew_confirm_check',
  'crew_keep_passcode',
  'crew_login_password',
  'crew_lookup',
  'crew_passcode_problem',
  'crew_reset_check',
  'crew_sign_in_check',
  'crew_sign_in_to_delete',
  'crew_sign_up_check',
  'deny_join_request',
  'invite_supervisor',
  'is_last_supervisor',
  'is_member',
  'is_supervisor',
  'join_company',
  'lift_join_bar',
  'make_passcode_reset_code',
  'member_company_ids',
  'my_companies',
  'my_join_requests',
  'my_supervisor_invitations',
  'push_records',
  'read_shared_records',
  'records_open_company_ids',
  'release_roster_claim',
  'resend_supervisor_invitation',
  'roster_after_reactivate',
  'roster_before_delete',
  'roster_before_write',
  'roster_keeps_a_supervisor',
  'roster_names_look_apart',
  'roster_sign_ins',
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
  'crew_key',
  'crew_logins',
  'crew_sign_in_tries',
  'join_holds',
  'join_requests',
  'notifications',
  'record_counters',
  'record_history',
  'record_usage',
  'records',
  'roster',
  'stripe_events',
  'supervisor_invitations',
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
  // Crew passcodes: the digests and counts, and their key, kept by the crew functions alone.
  crew_logins: { table: [], insert: [], update: [] },
  crew_key: { table: [], insert: [], update: [] },
  // The limit on crew-auth tries from one address, kept by crew_try_counted alone.
  crew_sign_in_tries: { table: [], insert: [], update: [] },
  // Supervisor invitations, kept by the invitation functions alone.
  supervisor_invitations: { table: [], insert: [], update: [] },
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
// with 401 or 403, 22023, 23514 and P0001 (a raise with no code of its own) with 400, 23505 with 409,
// and P0002, P0004, 55000 and the rest of the classes P0 and 55 with 500, which tells the caller, and a
// scanner, that the server failed when it only said no. So every raise in a function, whatever its
// shape, is a code PostgREST answers with a 4xx: one the function chooses, and one it catches and
// raises again.
const ANSWERED_WITH_4XX = {
  42501: '401 or 403',
  22023: '400',
  23514: '400',
  P0001: '400',
  23505: '409',
  PT402: '402',
  PT404: '404',
  PT409: '409',
  PT429: '429',
};
// Not a refusal: something other than push_records (the owner, in the SQL editor) wrote the record
// between push_records' read and its insert, and the call is told to try again; PostgREST makes it
// again by itself and it then finds the record (supabase/README.md, "When a function refuses";
// record_races.db.mjs).
const TRY_AGAIN = { push_records: '40001' };

// "Not found, or not the caller's" is PT404 and "not in a state to do that" PT409 (P0002 and 55000
// before migration 20261117000600), each with the words it had, in the order the function raises them.
const NOT_FOUND = 'PT404';
const WRONG_STATE = 'PT409';
const NO_SUCH_REQUEST = [NOT_FOUND, 'No such join request.'];
const ALREADY_DECIDED = [WRONG_STATE, 'That join request has already been decided.'];
const NO_SUCH_INVITATION = [NOT_FOUND, 'No such invitation.'];
const ROW_TAKEN = [WRONG_STATE, 'That roster row is taken off the roster or held by an email sign-in.', 'row_taken'];
const INVITATION_CLOSED = [WRONG_STATE, 'That invitation has expired, or was cancelled or accepted.', 'invitation_closed'];
const NOT_FOUND_OR_WRONG_STATE = {
  accept_supervisor_invitation: [
    NO_SUCH_INVITATION,
    [WRONG_STATE, 'Sign in with the confirmed email address the invitation was sent to.', 'wrong_email'],
    INVITATION_CLOSED,
    [WRONG_STATE, "This account is already on that company's roster.", 'already_on_roster'],
    ROW_TAKEN,
  ],
  approve_join_request: [
    NO_SUCH_REQUEST,
    NO_SUCH_REQUEST,
    ALREADY_DECIDED,
    [WRONG_STATE, 'That person is already on the roster.', 'Deny the request to close it.'],
    [NOT_FOUND, 'No such roster row.'],
    [WRONG_STATE, 'That roster row is not active.'],
    [WRONG_STATE, 'That roster row is already claimed.', 'Approve with replace_claim to hand it to this person in one step, or release it first.'],
  ],
  close_company: [
    [NOT_FOUND, 'No such company.'],
    [NOT_FOUND, 'No such company.'],
    [WRONG_STATE, 'Someone else can take over this company. Make them a supervisor instead.', 'someone_can_take_over'],
    [WRONG_STATE, "The company's subscription is still running. Cancel it first.", 'subscription_running'],
  ],
  cancel_supervisor_invitation: [NO_SUCH_INVITATION, [WRONG_STATE, 'That invitation has been accepted.', 'invitation_closed']],
  company_billing: [[NOT_FOUND, 'No such company.']],
  crew_account_on_row: [[NOT_FOUND, 'No such roster row.'], [WRONG_STATE, 'That roster row has no passcode sign-in.', 'not_a_passcode_account']],
  crew_keep_passcode: [
    [WRONG_STATE, 'A supervisor signs in with email, not a passcode.', 'supervisor_needs_email'],
    [WRONG_STATE, 'A passcode sign-in is for one company only.', 'passcode_account_elsewhere'],
  ],
  deny_join_request: [NO_SUCH_REQUEST, NO_SUCH_REQUEST, ALREADY_DECIDED],
  invite_supervisor: [[NOT_FOUND, 'No such roster row.'], ROW_TAKEN],
  lift_join_bar: [NO_SUCH_REQUEST],
  push_records: [[NOT_FOUND, 'No such company.']],
  read_shared_records: [[NOT_FOUND, 'No such company.']],
  release_roster_claim: [[NOT_FOUND, 'No such roster row.']],
  resend_supervisor_invitation: [NO_SUCH_INVITATION, INVITATION_CLOSED, ROW_TAKEN],
  roster_before_write: [
    [WRONG_STATE, 'That roster row is already claimed by another account.', 'A supervisor can release it first.'],
    [WRONG_STATE, 'A supervisor signs in with email, not a passcode.', 'supervisor_needs_email'],
    [WRONG_STATE, 'A passcode sign-in is for one company only.', 'passcode_account_elsewhere'],
  ],
  roster_sign_ins: [[NOT_FOUND, 'No such company.']],
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

/**
 * A function's source with its comments taken out, and each string literal ('...', E'...', $tag$...$tag$)
 * and quoted identifier set aside, so that a word inside one is never read as code. `code` has a
 * placeholder (§n§) where each was; `literals[n]` is its text as written.
 */
function setAside(src) {
  const literals = [];
  let code = '';
  const keep = (text) => {
    code += `§${literals.push(text) - 1}§`;
  };
  const afterWord = () => /[A-Za-z0-9_$]$/.test(code);
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('--', i)) {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      code += ' ';
    } else if (src.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (src.startsWith('/*', i)) (depth += 1), (i += 2);
        else if (src.startsWith('*/', i)) (depth -= 1), (i += 2);
        else i += 1;
      } while (depth > 0 && i < src.length);
      code += ' ';
    } else if (src[i] === '$' && !afterWord() && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(src.slice(i))) {
      const [tag] = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      const close = src.indexOf(tag, i + tag.length);
      const end = close === -1 ? src.length : close + tag.length;
      keep(src.slice(i, end));
      i = end;
    } else if (src[i] === "'" || src[i] === '"' || (/[eE]/.test(src[i]) && src[i + 1] === "'" && !afterWord())) {
      const escapes = src[i] !== "'" && src[i] !== '"';
      const quote = escapes ? "'" : src[i];
      let j = i + (escapes ? 2 : 1);
      for (; j < src.length; j += 1) {
        if (escapes && src[j] === '\\') j += 1;
        else if (src[j] === quote && src[j + 1] === quote) j += 1;
        else if (src[j] === quote) break;
      }
      keep(src.slice(i, j + 1));
      i = j + 1;
    } else {
      code += src[i];
      i += 1;
    }
  }
  return { code, literals };
}

const TOKEN = /\s*(?:(§(\d+)§)|([A-Za-z_][A-Za-z0-9_$]*)|(:=|[=,()])|(\S))/y;

/** The tokens of a piece of set-aside code: literals (with their text as written), words and the rest. */
function tokensOf(code, literals) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(code); m && m[0].trim(); m = TOKEN.exec(code)) {
    if (m[1]) tokens.push({ kind: 'literal', text: literals[Number(m[2])] });
    else if (m[3]) tokens.push({ kind: 'word', text: m[3], word: m[3].toLowerCase() });
    else tokens.push({ kind: 'mark', text: m[4] ?? m[5] });
  }
  return tokens;
}

const LEVELS = new Set(['debug', 'log', 'info', 'notice', 'warning', 'exception']);

/**
 * What one RAISE says, in each of its shapes (the PostgreSQL manual, "Errors and Messages"):
 *   raise [level] 'format' [, expression ...] [using option = expression, ...]
 *   raise [level] condition_name [using ...]
 *   raise [level] sqlstate 'code' [using ...]
 *   raise [level] using option = expression, ...
 *   raise                                   (in a handler: raise again what it caught)
 * With no level, the level is exception. Keywords and option names in any case, = or :=, any spacing.
 */
function readRaise(tokens) {
  if (tokens.length === 0) return { again: true };
  let k = 0;
  const isWord = (word) => tokens[k]?.kind === 'word' && tokens[k].word === word;
  const raise = { level: 'exception', options: {} };
  if (tokens[k]?.kind === 'word' && LEVELS.has(tokens[k].word)) raise.level = tokens[(k += 1) - 1].word;
  if (k < tokens.length && !isWord('using')) {
    if (isWord('sqlstate')) {
      raise.sqlstate = tokens[k + 1];
      k += 2;
    } else if (tokens[k].kind === 'literal') {
      raise.format = tokens[k].text;
      k += 1;
      let depth = 0;
      for (; k < tokens.length && !(depth === 0 && isWord('using')); k += 1) {
        if (tokens[k].text === '(') depth += 1;
        else if (tokens[k].text === ')') depth -= 1;
        else if (tokens[k].text === ',' && depth === 0) raise.formatArguments = true;
      }
    } else if (tokens[k].kind === 'word') {
      raise.condition = tokens[k].text;
      k += 1;
    }
  }
  if (isWord('using')) {
    k += 1;
    while (k < tokens.length) {
      const name = tokens[k].word ?? tokens[k].text;
      k += 2; // the option's name, and = or :=
      const value = [];
      for (let depth = 0; k < tokens.length && !(depth === 0 && tokens[k].text === ','); k += 1) {
        if (tokens[k].text === '(') depth += 1;
        else if (tokens[k].text === ')') depth -= 1;
        value.push(tokens[k]);
      }
      k += 1;
      raise.options[name] = value;
    }
  }
  return raise;
}

const constant = (value) => (value?.length === 1 && value[0].kind === 'literal' ? value[0].text : null);
const asText = (value) => value?.map((token) => token.text).join(' ') ?? null;
const CONDITION = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HANDLER = /\bwhen\s+((?:sqlstate\s+§\d+§|[A-Za-z_][A-Za-z0-9_]*)(?:\s+or\s+(?:sqlstate\s+§\d+§|[A-Za-z_][A-Za-z0-9_]*))*)\s+then\b/gi;

/** The code PostgreSQL itself gives a raise written this way: it is raised, once, in a DO block of its own. */
const sqlstates = new Map();
async function sqlstateOf(statement) {
  if (!sqlstates.has(statement)) {
    sqlstates.set(statement, (await errorOf(db.admin(`do $probe$ begin ${statement}; end $probe$`))).code);
  }
  return sqlstates.get(statement);
}

/**
 * Every raise in a function's source, whatever its shape, with the code it raises as PostgreSQL works it
 * out: `code` (null when the code is an expression worked out as it runs), or `codes` for a raise in a
 * handler, one for each condition it catches (undefined for `others`: whatever was caught). Notices and
 * warnings are left out: they do not stop the function. An ASSERT is a raise of P0004 when it fails.
 * `message` and `hint` are as written.
 */
async function raisesOf(src) {
  const { code, literals } = setAside(src);
  const found = [];
  for (const statement of code.matchAll(/\b(raise|assert)\b([^;]*);/gi)) {
    const text = (statement[0].replace(/§(\d+)§/g, (_, n) => literals[Number(n)])).replace(/\s+/g, ' ').trim();
    if (statement[1].toLowerCase() === 'assert') {
      if (/(^|[;(]|\b(then|else|loop|begin))\s*$/i.test(code.slice(0, statement.index))) found.push({ code: await sqlstateOf('assert false'), message: null, hint: null, text });
      continue;
    }
    const raise = readRaise(tokensOf(statement[2], literals));
    if (raise.again) {
      // The handler it is in: the last "when ... then" after the last "exception when" before it.
      const before = code.slice(0, statement.index);
      const block = [...before.matchAll(/\bexception\s+when\b/gi)].at(-1);
      const handler = block ? [...before.slice(block.index).matchAll(HANDLER)].at(-1) : null;
      const codes = [];
      for (const condition of handler ? handler[1].split(/\s+or\s+/i) : ['others']) {
        const sqlstate = /^sqlstate\s+§(\d+)§$/i.exec(condition);
        if (sqlstate) codes.push(await sqlstateOf(`raise sqlstate ${literals[Number(sqlstate[1])]}`));
        else if (condition.toLowerCase() === 'others') codes.push(undefined);
        else codes.push(await sqlstateOf(`raise ${condition}`));
      }
      found.push({ codes, code: codes.length === 1 ? codes[0] : null, message: null, hint: null, text: `${text} (in a handler for ${handler?.[1] ?? 'others'})` });
      continue;
    }
    if (raise.level !== 'exception') continue;
    let sqlstate;
    if (raise.condition) sqlstate = CONDITION.test(raise.condition) ? await sqlstateOf(`raise ${raise.condition}`) : null;
    else if (raise.sqlstate) sqlstate = raise.sqlstate.kind === 'literal' ? await sqlstateOf(`raise sqlstate ${raise.sqlstate.text}`) : null;
    else if (raise.options.errcode) sqlstate = constant(raise.options.errcode) ? await sqlstateOf(`raise exception using errcode = ${constant(raise.options.errcode)}`) : null;
    else sqlstate = await sqlstateOf("raise exception 'No code of its own.'");
    const message = raise.options.message ? constant(raise.options.message) ?? asText(raise.options.message) : raise.format && !raise.formatArguments ? raise.format : raise.format ? text : null;
    found.push({ code: sqlstate, message, hint: raise.options.hint ? constant(raise.options.hint) ?? asText(raise.options.hint) : null, text });
  }
  return found;
}

// Every shape a raise can take in PL/pgSQL, and the code PostgreSQL itself gives it: the reader below must
// see each one, so that no refusal gets past the rule for being written another way.
const SHAPES = [
  ["raise exception using errcode = 'PT404', message = 'No such company.';", ['PT404']],
  ["RAISE EXCEPTION USING MESSAGE='Already decided.', ERRCODE='PT409', HINT='Reload.';", ['PT409']],
  ["raise exception using\n  errcode\t:=  '22023',\n  message = 'Type a name.';", ['22023']],
  ["raise exception using errcode = 'no_data_found', message = 'Gone.';", ['P0002']],
  ["raise exception using errcode = 'pt404', message = 'Lower case is a condition name, not a code.';", ['42704']],
  ["raise sqlstate 'P0002' using message = 'Gone.';", ['P0002']],
  ["raise exception sqlstate '55000';", ['55000']],
  ['raise no_data_found;', ['P0002']],
  ["Raise Exception Object_Not_In_Prerequisite_State using message = 'Not now.';", ['55000']],
  ["raise 'Nothing for %.', who;", ['P0001']],
  ["raise exception 'Nothing here.' using errcode = 'PT404';", ['PT404']],
  ["raise exception using message = 'No code at all.';", ['P0001']],
  ["raise exception using errcode = chosen, message = 'A code worked out when it runs.';", [null]],
  ["raise notice 'Only a notice.'; raise warning using message = 'Only a warning.'; raise debug 'x'; raise log 'x'; raise info 'x';", []],
  ["-- raise no_data_found;\n/* raise sqlstate 'P0002'; */ perform 'raise sqlstate ''P0002'';', $q$raise no_data_found;$q$, E'raise \\' no_data_found;';", []],
  ['begin insert into t values (1); exception when unique_violation then raise; end;', ['23505']],
  ['begin perform 1; exception when check_violation or sqlstate \'23505\' then raise; end;', ['23514', '23505']],
  ['begin perform 1; exception when others then raise; end;', [undefined]],
  ["assert n > 0, 'n is never zero';", ['P0004']],
];

describe('refusals', () => {
  it('are read whatever their shape: each raise, with the code PostgreSQL gives it', async () => {
    for (const [src, codes] of SHAPES) {
      const read = await raisesOf(src);
      assert.deepEqual(read.map((raise) => raise.codes ?? [raise.code]).flat(), codes, src);
    }
  });

  it('are each a code PostgREST answers with a 4xx, never one it answers with a 5xx', async (t) => {
    let raises = 0;
    const seen = {};
    for (const fn of await publicSources()) {
      for (const raise of await raisesOf(fn.src)) {
        raises += 1;
        for (const code of raise.codes ?? [raise.code]) {
          seen[code] = (seen[code] ?? 0) + 1;
          if (code === TRY_AGAIN[fn.name]) continue;
          const what = code === undefined ? 'whatever it caught' : code === null ? 'a code worked out as it runs' : code;
          assert.ok(Object.hasOwn(ANSWERED_WITH_4XX, code), `${fn.name} raises ${what}, which PostgREST does not answer with a 4xx: ${raise.text}`);
        }
      }
    }
    t.diagnostic(`${raises} raises read: ${JSON.stringify(seen)}`);
    assert.ok(raises >= 76, `only ${raises} raises were read: the reader has missed some`);
  });

  it('keep their words: not found is PT404 and not in a state to do that is PT409', async () => {
    const found = {};
    for (const fn of await publicSources()) {
      const these = (await raisesOf(fn.src)).filter((raise) => raise.code === NOT_FOUND || raise.code === WRONG_STATE);
      if (these.length) found[fn.name] = these.map((raise) => [raise.code, unquote(raise.message), ...(raise.hint ? [unquote(raise.hint)] : [])]);
    }
    assert.deepEqual(found, NOT_FOUND_OR_WRONG_STATE);
  });

  it('with a PT code, have a message that is a constant on one line: PostgREST writes it into the HTTP status line', async () => {
    let checked = 0;
    for (const fn of await publicSources()) {
      for (const raise of (await raisesOf(fn.src)).filter((one) => /^PT/.test(one.code ?? ''))) {
        checked += 1;
        // Printable ASCII only: a line break in it would end the status line and start a header of the caller's choosing.
        assert.match(raise.message ?? '', /^'(?:[\x20-\x26\x28-\x7e]|'')+'$/, `${fn.name}: ${raise.text}`);
      }
    }
    assert.ok(checked >= 19, `only ${checked} PT codes were read`);
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
    assert.deepEqual(columns.map((c) => c.attname), ['id', 'email', 'deleted_at', 'banned_until', 'email_confirmed_at']);
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
