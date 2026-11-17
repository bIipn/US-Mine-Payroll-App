// A fresh database on a real PostgreSQL server, for the few rules that only
// show when two transactions overlap. PGlite is one session, so it cannot act
// out two API requests at the same instant; a real server can.
//
// These tests run only when MINEMUSTER_TEST_DATABASE_URL names a throwaway
// PostgreSQL 15 or newer server, as a superuser that may create databases and
// roles, for example postgres://postgres@127.0.0.1:55461/postgres. Each test
// file makes its own database there, builds it the way harness.mjs does (the
// Supabase stand-ins, then every migration in order) and drops it at the end.
// Without the variable the tests are skipped and say why. Never point it at a
// Supabase project or at any database whose contents matter.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { migrationFiles, MIGRATIONS } from './harness.mjs';
import { SUPABASE_STUB } from './supabase-stub.mjs';

export const SERVER_URL = process.env.MINEMUSTER_TEST_DATABASE_URL ?? '';

let pg = null;
let missing = '';
if (!SERVER_URL) {
  missing = 'set MINEMUSTER_TEST_DATABASE_URL to a throwaway PostgreSQL server to act out overlapping transactions';
} else {
  try {
    pg = (await import('pg')).default;
  } catch (error) {
    missing = `the pg client could not be loaded (run npm install): ${error.message}`;
  }
}

/** Why these tests are skipped, or false when a server is there to run them on. */
export const skipWithoutServer = missing || false;

const urlFor = (database) => {
  const url = new URL(SERVER_URL);
  url.pathname = `/${database}`;
  return url.toString();
};

/** A new database on the server with the stand-ins and every migration applied. Drop it when done. */
export async function startServerDatabase() {
  const name = `minemuster_test_${randomUUID().replaceAll('-', '')}`;
  const root = new pg.Client({ connectionString: SERVER_URL });
  await root.connect();
  let admin;
  try {
    // Test files run at once, and the API roles belong to the whole server:
    // one file at a time makes its database and, if they are not there yet,
    // the roles. An advisory lock taken in the server's own database is held
    // across both.
    await root.query('select pg_advisory_lock(7262001)');
    await root.query(`create database ${name}`);
    const { rows } = await root.query("select count(*)::int as n from pg_roles where rolname in ('anon', 'authenticated', 'service_role')");
    const haveRoles = rows[0].n === 3;
    admin = new pg.Client({ connectionString: urlFor(name) });
    await admin.connect();
    await admin.query(haveRoles ? SUPABASE_STUB.replace(/^create role .*$/gm, '') : SUPABASE_STUB);
  } finally {
    await root.query('select pg_advisory_unlock(7262001)').catch(() => {});
    await root.end();
  }
  for (const file of await migrationFiles()) {
    const sql = await readFile(new URL(file, MIGRATIONS), 'utf8');
    try {
      await admin.query(`begin;\n${sql}\ncommit;`);
    } catch (error) {
      await admin.query('rollback');
      error.message = `${file}: ${error.message}`;
      throw error;
    }
  }
  return new ServerDatabase(name, admin);
}

class ServerDatabase {
  constructor(name, admin) {
    this.name = name;
    this.admin = admin;
    this.open = new Set();
  }

  async adminRows(sql, params) {
    return (await this.admin.query(sql, params)).rows;
  }

  async newAccount() {
    const id = randomUUID();
    await this.admin.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`]);
    return id;
  }

  /**
   * An API request in progress: its own connection and transaction, at the
   * given isolation level, as the authenticated role with this account's id
   * (or as `role`: anon, or service_role for the server key, with no account).
   * PostgREST's first statement in each transaction sets the claims, and at
   * REPEATABLE READ or SERIALIZABLE that statement fixes the snapshot.
   */
  async request(account, isolation = 'read committed', role = 'authenticated') {
    assert.match(isolation, /^(read committed|repeatable read|serializable)$/);
    assert.match(role, /^(anon|authenticated|service_role)$/);
    const client = new pg.Client({ connectionString: urlFor(this.name) });
    await client.connect();
    this.open.add(client);
    await client.query(`begin isolation level ${isolation}`);
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [account ?? '']);
    const [{ pid }] = (await client.query('select pg_backend_pid() as pid')).rows;
    return new Request(this, client, pid);
  }

  /** One whole request, committed: for setting a test up. */
  async asAccount(account, sql, params) {
    const request = await this.request(account);
    try {
      const result = await request.query(sql, params);
      await request.commit();
      return result.rows;
    } finally {
      await request.end();
    }
  }

  async drop() {
    for (const client of this.open) await client.end().catch(() => {});
    await this.admin.end();
    const root = new pg.Client({ connectionString: SERVER_URL });
    await root.connect();
    try {
      await root.query(`drop database if exists ${this.name} with (force)`);
    } finally {
      await root.end();
    }
  }
}

class Request {
  constructor(db, client, pid) {
    this.db = db;
    this.client = client;
    this.pid = pid;
  }

  query(sql, params) {
    return this.client.query(sql, params);
  }

  commit() {
    return this.client.query('commit');
  }

  rollback() {
    return this.client.query('rollback');
  }

  /**
   * Start a statement that may have to wait for another transaction. Resolves
   * once it is waiting on a lock, or has already finished; its outcome is
   * `settled`, which never rejects: {ok, rows} or {ok: false, code, message}.
   */
  async start(sql, params) {
    let done = false;
    const settled = this.client.query(sql, params).then(
      (result) => ({ ok: true, rows: result.rows }),
      (error) => ({ ok: false, code: error.code, message: error.message }),
    ).finally(() => {
      done = true;
    });
    for (let tries = 0; tries < 200 && !done; tries += 1) {
      const [row] = await this.db.adminRows('select wait_event_type from pg_stat_activity where pid = $1', [this.pid]);
      if (row?.wait_event_type === 'Lock') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { settled };
  }

  async end() {
    this.db.open.delete(this.client);
    await this.client.end();
  }
}
