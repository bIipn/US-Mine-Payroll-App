// A fresh local database for each test file, built the way a Supabase project
// is: the stand-ins for what Supabase provides (supabase-stub.mjs), then every
// migration in supabase/migrations in order. Nothing here talks to Supabase or
// any hosted database.
//
// Requests are made the way PostgREST makes them: as the role anon or
// authenticated, with the signed-in account's id in request.jwt.claim.sub,
// and, when a test gives them, the request's headers in request.headers.
//
// The names in these tests are made up, and the companies are "Test Pit A",
// "Test Pit B" and so on. The repository is public: keep it that way.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { SUPABASE_STUB } from './supabase-stub.mjs';

export const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** Migration file names, in the order they are applied. */
export async function migrationFiles() {
  return (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
}

/**
 * A new database with the stand-ins and every migration applied. Close it when done.
 *
 * By default the migrations run as PGlite's superuser. On Supabase they run as
 * `postgres`, which is not a superuser, so `owner` applies them as a
 * non-superuser role of that name instead, given what Supabase gives postgres
 * on the database, schema public, auth.users and Vault's decrypted secrets.
 * `extensions` are PGlite
 * extensions to load, and `before` is SQL run as that owner before the
 * migrations (to put an extension in public, say), so a statement that would
 * need a superuser on Supabase fails here too.
 */
export async function startDatabase({ owner = null, extensions = {}, before = '' } = {}) {
  const pg = new PGlite({ extensions });
  await pg.exec(SUPABASE_STUB);
  if (owner) {
    assert.match(owner, NAME);
    await pg.exec(`
      create role ${owner} nologin;
      grant create on database postgres to ${owner};
      grant usage, create on schema public to ${owner};
      grant usage on schema auth to ${owner};
      grant select, references on auth.users to ${owner};
      grant usage on schema vault to ${owner};
      grant select on vault.decrypted_secrets to ${owner};`);
  }
  const asOwner = owner ? `set role ${owner};\n` : '';
  if (before) await pg.exec(`${asOwner}${before}\nreset role;`);
  for (const name of await migrationFiles()) {
    const sql = await readFile(new URL(name, MIGRATIONS), 'utf8');
    try {
      // One string of statements runs as one transaction, as each migration does on Supabase.
      await pg.exec(`${asOwner}${sql}`);
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    } finally {
      if (owner) await pg.exec('reset role');
    }
  }
  return new Database(pg);
}

const ROLES = new Set(['anon', 'authenticated', 'service_role']);
const NAME = /^[a-z_]+$/;

class Database {
  #queue = Promise.resolve();
  #accounts = 0;

  constructor(pg) {
    this.pg = pg;
  }

  /** One statement at a time: the database is a single session, and each request sets its role. */
  #inTurn(work) {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** As postgres, the owner of everything: what a migration or the SQL editor sees. */
  admin(sql, params) {
    return this.#inTurn(() => this.pg.query(sql, params));
  }

  /** Rows of a query run as postgres. */
  async adminRows(sql, params) {
    return (await this.admin(sql, params)).rows;
  }

  /** A new Supabase Auth account. Returns its id. */
  async newAccount(label = 'person') {
    const id = randomUUID();
    this.#accounts += 1;
    await this.admin('insert into auth.users (id, email) values ($1, $2)', [id, `${label}-${this.#accounts}@example.test`]);
    return id;
  }

  /** Requests from a signed-in account. */
  as(userId) {
    assert.ok(userId, 'as() needs an account id');
    return new Session(this, 'authenticated', userId);
  }

  /**
   * Requests with the public key and nobody signed in. `headers` are the
   * request's headers as PostgREST hands them over (lower-case names), such
   * as the x-forwarded-for Supabase's gateway sets.
   */
  anon({ headers = null } = {}) {
    return new Session(this, 'anon', null, headers);
  }

  /** The authenticated role with no account id: what every function must refuse. */
  noAccount() {
    return new Session(this, 'authenticated', null);
  }

  /** Requests with the server's key. */
  serviceRole() {
    return new Session(this, 'service_role', null);
  }

  run(role, userId, sql, params, headers = null) {
    assert.ok(ROLES.has(role), `unknown role ${role}`);
    return this.#inTurn(async () => {
      await this.pg.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
      await this.pg.query("select set_config('request.headers', $1, false)", [headers ? JSON.stringify(headers) : '']);
      await this.pg.exec(`set role ${role}`);
      try {
        return await this.pg.query(sql, params);
      } finally {
        await this.pg.exec('reset role');
        await this.pg.query("select set_config('request.jwt.claim.sub', '', false)");
        await this.pg.query("select set_config('request.headers', '', false)");
      }
    });
  }

  close() {
    return this.pg.close();
  }
}

/** Named arguments, the way PostgREST passes them to a function: name => $n. */
function namedArguments(args) {
  const keys = Object.keys(args);
  for (const key of keys) assert.match(key, NAME, `argument name ${key}`);
  return { list: keys.map((key, i) => `${key} => $${i + 1}`).join(', '), values: keys.map((key) => args[key]) };
}

class Session {
  constructor(db, role, userId, headers = null) {
    this.db = db;
    this.role = role;
    this.userId = userId;
    this.headers = headers;
  }

  /** The whole result: rows, and affectedRows for a write. */
  query(sql, params) {
    return this.db.run(this.role, this.userId, sql, params, this.headers);
  }

  async rows(sql, params) {
    return (await this.query(sql, params)).rows;
  }

  /** Call a function that returns one value (or nothing) and get the value. */
  async call(fn, args = {}) {
    assert.match(fn, NAME);
    const { list, values } = namedArguments(args);
    const [row] = await this.rows(`select public.${fn}(${list}) as result`, values);
    return row.result;
  }

  /** Call a function that returns a table and get its rows. */
  async callRows(fn, args = {}) {
    assert.match(fn, NAME);
    const { list, values } = namedArguments(args);
    return this.rows(`select * from public.${fn}(${list})`, values);
  }

  /** How many rows a write touched. */
  async affected(sql, params) {
    return (await this.query(sql, params)).affectedRows ?? 0;
  }
}

// ---- Errors ---------------------------------------------------------------------------------------

/** The error a request ends in, as the API would pass it on. Fails if the request succeeded. */
export async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return { code: error.code, message: error.message, detail: error.detail, hint: error.hint };
  }
  assert.fail('expected the request to be refused');
}

/** The request is refused with this SQLSTATE, and a message that matches, when one is given. */
export async function refused(promise, code, message) {
  const error = await errorOf(promise);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  if (message) assert.match(error.message, message);
  return error;
}

export const NOT_SIGNED_IN = '42501';
export const NO_PRIVILEGE = '42501';
// PostgREST answers a PTnnn code with HTTP nnn. P0002 and 55000, the codes these refusals had before
// migration 20261117000600, it answers with 500.
export const NOT_FOUND = 'PT404';
export const WRONG_STATE = 'PT409';
export const BAD_INPUT = '22023';
export const LAST_SUPERVISOR = '23514';

// ---- Companies and people -------------------------------------------------------------------------

/**
 * A company started by a new account, which is its supervisor, with whoever
 * else is on its roster (not yet claimed). Rows are keyed "First Last".
 *
 * A supervisor reads the company's records only while it has MineMuster
 * (migration 20261117000500), so the company is let in without paying, with a
 * billing_overrides row, unless `comped` is false: the billing tests start
 * with none.
 */
export async function startCompany(db, { name = 'Test Pit A', state = 'CA', timezone = 'America/Los_Angeles', supervisor = ['Sam', 'Ortiz'], roster = [], comped = true } = {}) {
  const owner = await db.newAccount('supervisor');
  const [made] = await db.as(owner).callRows('create_company', {
    name,
    state,
    timezone,
    first_name: supervisor[0],
    last_name: supervisor[1],
    title: null,
  });
  if (comped) await db.admin("insert into public.billing_overrides (company_id, reason) values ($1, 'A test company')", [made.company_id]);
  const [ownRow] = await db.adminRows('select id from public.roster where company_id = $1 and user_id = $2', [made.company_id, owner]);
  const rows = { [`${supervisor[0]} ${supervisor[1]}`]: ownRow.id };
  for (const person of roster) await addToRoster(db, owner, made.company_id, person, rows);
  return { id: made.company_id, code: made.join_code, owner, ownRow: ownRow.id, rows };
}

/** A supervisor adds a row to the roster through the API. Returns its id. */
export async function addToRoster(db, supervisor, companyId, person, rows = {}) {
  const [row] = await db.as(supervisor).rows(
    `insert into public.roster (company_id, first_name, last_name, title, role, active)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [companyId, person.first, person.last, person.title ?? null, person.role ?? 'employee', person.active ?? true],
  );
  rows[`${person.first} ${person.last}`] = row.id;
  return row.id;
}

/** An account types a code and a name. */
export function join(db, account, code, first, last) {
  return db.as(account).call('join_company', { code, first_name: first, last_name: last });
}

/** A new account that joins by claiming the row with this name. Returns the account id. */
export async function newMember(db, company, first, last) {
  const account = await db.newAccount('member');
  const result = await join(db, account, company.code, first, last);
  assert.equal(result.status, 'joined', `${first} ${last} should join ${JSON.stringify(result)}`);
  return account;
}

/**
 * A second supervisor for a company: a supervisor row, and a new account let
 * onto it. A supervisor row is never handed out by a typed name, so typing it
 * leaves a request (reason supervisor_row) that the company's owner approves
 * onto that row, which keeps its supervisor role.
 */
export async function secondSupervisor(db, company, first = 'Riley J', last = 'Quinn') {
  const rowId = await addToRoster(db, company.owner, company.id, { first, last, role: 'supervisor' }, company.rows);
  const account = await db.newAccount('member');
  const result = await join(db, account, company.code, first, last);
  assert.equal(result.status, 'pending', `${first} ${last} should wait for approval ${JSON.stringify(result)}`);
  assert.equal(result.reason, 'supervisor_row', JSON.stringify(result));
  const [request] = await db.adminRows("select id from public.join_requests where user_id = $1 and status = 'pending'", [account]);
  await db.as(company.owner).call('approve_join_request', { request_id: request.id, roster_id: rowId });
  return account;
}

/** A roster row as the owner sees it. */
export async function rosterRow(db, id) {
  const [row] = await db.adminRows('select * from public.roster where id = $1', [id]);
  return row;
}

/** A uuid nothing has. */
export const nobody = () => randomUUID();
