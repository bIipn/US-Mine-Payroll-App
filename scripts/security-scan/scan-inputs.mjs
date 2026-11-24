#!/usr/bin/env node
// Writes what the three HawkScan configs at the repository root read from the environment, from
// the local scan stack's own files. It reads fixtures.json and the stack's description files,
// and opens no socket.
//
//   node scan-inputs.mjs --home <private folder> --app-id <StackHawk application id>
//
// It writes, into <home>/scan and readable by the owner only:
//   scan.env           every ${VAR} the configs name: ids, the made-up accounts, the local
//                      publishable key, the scan guard's address, and the paths of the two files
//                      below
//   openapi-scan.json  PostgREST's description and the webhook's in one Swagger 2.0 file, every
//                      path with its prefix, and a table read asking for nothing but the rows the
//                      config gives real values for
//   api-seed.har       one well-formed request for each call the description cannot render
//
// Everything in these files is made up or made at random on this machine, and none of it goes in
// the repository. The secret key and the webhook's signing secret are never written: no config
// reads them, and the scanner must not hold them.
//
// Run it again after anything that gives the stack new ids or keys: "reset --hard",
// "stop --purge", a rebuilt database. A plain reset keeps them.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GUARD_HOST, GUARD_PORT, GUARD_URL } from './egress-guard.mjs';
import { LOCAL_SERVER, homeFrom, layout, readArgs } from './sites/layout.mjs';

/** A well-formed id that names no row. */
const NOWHERE = '00000000-0000-4000-8000-000000000000';

/** Where the inputs go: `scan` in the private folder. */
export const inputsFolder = (home) => path.join(home, 'scan');

/** The variables a scan.env holds, as a map. An older file's application id can be kept this way. */
export function readEnvFile(file) {
  const found = {};
  if (!existsSync(file)) return found;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)='(.*)'$/.exec(line);
    if (match) found[match[1]] = match[2].replaceAll(`'\\''`, `'`);
  }
  return found;
}

const shellQuoted = (value) => `'${String(value).replaceAll(`'`, `'\\''`)}'`;

/**
 * The columns a table read filters on in the scan, by table, and the made-up thing each one is
 * given ("eq.<its id>"). The value goes into the description as the filter's default: the scanner
 * uses a parameter's default, and leaves customVariables out of query parameters (seen on 18
 * November 2026, HawkScan 6.7.4: every read built from the description got made-up words).
 */
export const TABLE_FILTERS = { companies: ['id'], roster: ['company_id', 'id'] };
export const DEFAULT_TABLE_FILTERS = ['company_id'];
export const filtersOf = (table) => TABLE_FILTERS[table] ?? DEFAULT_TABLE_FILTERS;
const TABLE_FILTER_VALUES = { 'companies.id': 'companyA', 'roster.id': 'rosterA3', company_id: 'companyA' };
const tableFilterValue = (table, column) => TABLE_FILTER_VALUES[`${table}.${column}`] ?? TABLE_FILTER_VALUES[column];

/**
 * The inputs of each function the scan gives a made-up value to, by function, and which value.
 * They go into the description as defaults, for the query of a GET and the body of a POST.
 */
export const FUNCTION_INPUTS = {
  is_member: { company_id: 'companyA' },
  is_supervisor: { company_id: 'companyA' },
  push_records: { company_id: 'companyA' },
  rotate_join_code: { company_id: 'companyA' },
  company_billing: { p_company_id: 'companyA' },
  approve_join_request: { request_id: 'requestP1', roster_id: 'rosterA3' },
  deny_join_request: { request_id: 'requestP1' },
  lift_join_bar: { request_id: 'requestP1' },
  release_roster_claim: { roster_id: 'rosterA3' },
  // A signed-in account's lookup (migration 20261122000100), as every input here is: the description
  // is PostgREST's as a signed-in account. The crew_* checks are the server key's alone, so they are
  // in neither the description nor the recorded requests.
  company_by_code: { code: 'codeB' },
  join_company: { code: 'codeB' },
};

/** The made-up things FUNCTION_INPUTS and TABLE_FILTER_VALUES name, from the stack's fixtures. */
function madeUpValues(fixtures) {
  const A = fixtures.companies.A;
  return { companyA: A.id, rosterA3: A.roster.A3.rosterId, requestP1: fixtures.pendingJoinRequest.id, codeB: fixtures.companies.B.joinCode };
}

/**
 * A table read as the description has it, with only the parameters a scanner can fill well.
 *
 * PostgREST describes every read with select, order, Range, limit, offset and a filter for each
 * column, all optional and all plain strings. A scanner fills them with made-up words, and
 * PostgREST answers any of those 400 before a row or a policy is looked at ("select=John Doe" is
 * "column roster.John Doe does not exist"). So a read keeps the filters the config gives real
 * values for, and the Prefer header, whose one value is listed; the rest are left out, and the
 * table's own columns and ordering are asked for by the recorded requests. Writes are left as they
 * are: a write with a made-up filter is turned down, and that is what keeps the scan from
 * changing rows it did not mean to.
 */
function trimmedRead(operation, table, shared, values) {
  const keep = new Set(filtersOf(table).map((column) => `rowFilter.${table}.${column}`));
  const named = (parameter) => (parameter.$ref ?? '').replace(/^#\/parameters\//, '');
  const kept = (operation.parameters ?? []).filter((parameter) => keep.has(named(parameter)) || named(parameter) === 'preferCount');
  for (const name of keep) if (!kept.some((parameter) => named(parameter) === name)) throw new Error(`The description has no filter ${name} for the scan to fill.`);
  for (const parameter of kept) if (parameter.$ref && !shared?.[named(parameter)]) throw new Error(`The description names ${parameter.$ref} and does not define it.`);
  // Each filter is written out in place with its value as the default, since a shared parameter
  // has one default for every table that points at it.
  const filled = kept.map((parameter) => {
    if (!keep.has(named(parameter))) return parameter;
    const filter = shared[named(parameter)];
    const value = values[tableFilterValue(table, filter.name)];
    if (value === undefined) throw new Error(`No made-up value is named for ${table}.${filter.name}.`);
    return { ...filter, default: `eq.${value}` };
  });
  return { ...operation, parameters: filled };
}

/** A function's operations, with each input the scan gives a value to defaulting to that value. */
function filledFunction(item, name, values) {
  const inputs = FUNCTION_INPUTS[name];
  if (!inputs) return item;
  const valueOf = (input) => (input in inputs ? values[inputs[input]] : undefined);
  const operations = {};
  for (const [method, operation] of Object.entries(item)) {
    const parameters = (operation.parameters ?? []).map((parameter) => {
      if (parameter.in === 'query' && valueOf(parameter.name) !== undefined) return { ...parameter, default: valueOf(parameter.name) };
      if (parameter.in === 'body' && parameter.schema?.properties) {
        const properties = Object.fromEntries(Object.entries(parameter.schema.properties).map(([input, schema]) => [input, valueOf(input) === undefined ? schema : { ...schema, default: valueOf(input) }]));
        return { ...parameter, schema: { ...parameter.schema, properties } };
      }
      return parameter;
    });
    operations[method] = { ...operation, parameters };
  }
  return operations;
}

/** PostgREST's description as a signed-in account, and the webhook's, in one file. */
function mergedDescription(rest, webhook, values) {
  if (rest.swagger !== '2.0' || rest.basePath !== '/rest/v1') throw new Error('The PostgREST description is not the shape this script knows.');
  const webhookBase = new URL(webhook.servers[0].url).pathname.replace(/\/$/, '');
  // app.host stays at the origin, because sign-in, the tables and the function live under three
  // prefixes. So every path here carries its own prefix and the file's base path is "/".
  const paths = {};
  for (const [name, item] of Object.entries(rest.paths)) {
    const table = /^\/([a-z_]+)$/.exec(name)?.[1];
    const fn = /^\/rpc\/([a-z_]+)$/.exec(name)?.[1];
    paths[`${rest.basePath}${name}`] = table && item.get ? { ...item, get: trimmedRead(item.get, table, rest.parameters, values) } : fn ? filledFunction(item, fn, values) : item;
  }
  for (const [name, item] of Object.entries(webhook.paths)) {
    const operations = {};
    for (const [method, op] of Object.entries(item)) {
      const parameters = (op.parameters ?? []).map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required), type: p.schema?.type ?? 'string', description: p.description }));
      const body = op.requestBody?.content?.['application/json']?.schema;
      if (body) parameters.push({ name: 'event', in: 'body', required: true, schema: body });
      operations[method] = {
        summary: op.summary,
        tags: ['(function) stripe-webhook'],
        consumes: ['application/json'],
        produces: ['application/json'],
        parameters,
        responses: Object.fromEntries(Object.entries(op.responses).map(([status, r]) => [status, { description: r.description }])),
        security: [], // The function takes no key and no token.
      };
    }
    paths[`${webhookBase}${name}`] = operations;
  }
  const title = 'MineMuster server (local scan stack): PostgREST and the stripe-webhook function';
  return { description: { ...rest, info: { ...rest.info, title }, basePath: '/', paths }, webhookBase };
}

/**
 * The description cannot say that a table filter is written "eq.<value>", that push_records
 * takes a list of changes, or that the contact form's hidden field must stay empty. Each request
 * here is one the dashboard, the phone or the website really sends, with made-up values. The
 * scanner replays them and then attacks each value in turn.
 */
function seedRequests({ gateway, key, fixtures, webhookBase }) {
  const A = fixtures.companies.A;
  const B = fixtures.companies.B;
  const a3Row = A.roster.A3.rosterId;
  const request = fixtures.pendingJoinRequest.id;

  const entries = [];
  const add = (method, route, { query = {}, body, headers = {} } = {}) => {
    // Commas stay as they are: the scanner encodes a "%2C" in a recorded request a second time.
    const encoded = (text) => encodeURIComponent(text).replaceAll('%2C', ',');
    const search = Object.entries(query).map(([name, value]) => `${encoded(name)}=${encoded(value)}`).join('&');
    const url = `${gateway}${route}${search ? `?${search}` : ''}`;
    const all = { Accept: 'application/json', apikey: key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers };
    const asked = {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(all).map(([name, value]) => ({ name, value })),
      queryString: Object.entries(query).map(([name, value]) => ({ name, value: String(value) })),
      cookies: [],
      headersSize: -1,
      bodySize: -1,
    };
    if (body !== undefined) asked.postData = { mimeType: 'application/json', text: JSON.stringify(body) };
    entries.push({
      startedDateTime: '2026-11-18T00:00:00.000Z',
      time: 0,
      request: asked,
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: 'application/json' }, redirectURL: '', headersSize: -1, bodySize: -1 },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    });
  };
  const rpc = (name, body = {}) => add('POST', `/rest/v1/rpc/${name}`, { body });

  // Tables, read as the dashboard reads them (dashboard/src/lib/api.ts).
  const recordColumns = 'kind,id,rev,data,deleted,created_by,updated_by,created_at,updated_at';
  const rosterColumns = 'id,company_id,first_name,last_name,title,role,active,user_id,claimed_at,created_at';
  const ofA = { company_id: `eq.${A.id}` };
  add('GET', '/rest/v1/companies', { query: { select: 'id,name,state,timezone,logo_path,pay_period,updated_at', id: `eq.${A.id}` } });
  add('GET', '/rest/v1/roster', { query: { select: rosterColumns, ...ofA, order: 'last_name.asc,first_name.asc' } });
  add('GET', '/rest/v1/join_requests', { query: { select: 'id,company_id,user_id,first_name,last_name,reason,status,roster_id,decided_by,decided_at,created_at', ...ofA, order: 'created_at.desc', limit: '200' } });
  add('GET', '/rest/v1/notifications', { query: { select: 'id,company_id,kind,roster_id,request_id,created_at,read_at', ...ofA, order: 'created_at.desc', limit: '50' } });
  add('GET', '/rest/v1/records', { query: { select: recordColumns, ...ofA, order: 'kind.asc,id.asc', offset: '0', limit: '1000' } });
  add('GET', '/rest/v1/records', { query: { select: recordColumns, ...ofA, kind: 'eq.shift', id: 'eq.shift-1' } });
  add('GET', '/rest/v1/records', { query: { select: recordColumns, ...ofA, 'data->>equipmentId': 'eq.eq-1' } });
  add('GET', '/rest/v1/record_history', { query: { select: 'version,rev,base,data,deleted,by,at', ...ofA, kind: 'eq.shift', id: 'eq.shift-1', order: 'version.desc', limit: '12' } });
  add('GET', '/rest/v1/record_history', { query: { select: 'id,at', ...ofA, kind: 'eq.equipment', deleted: 'eq.true', order: 'at.desc', limit: '500' } });
  add('GET', '/rest/v1/billing_subscriptions', { query: { select: '*', ...ofA } });
  add('GET', '/rest/v1/billing_overrides', { query: { select: '*', ...ofA } });

  // Tables, written. The only roster row named is A3's, which no account holds, so junk here
  // takes nobody out of the company. The DELETE names no row at all.
  add('POST', '/rest/v1/roster', { query: { select: rosterColumns }, headers: { Prefer: 'return=representation' }, body: [{ company_id: A.id, first_name: 'Dana', last_name: 'Reyes', title: 'Mechanic', role: 'employee' }] });
  add('PATCH', '/rest/v1/roster', { query: { id: `eq.${a3Row}` }, body: { title: 'Loader operator' } });
  add('DELETE', '/rest/v1/roster', { query: { id: `eq.${NOWHERE}` } });
  // PUT is not in PostgREST's description. A PUT carries the row's id, which no account may
  // insert, so expect a refusal.
  const putRow = '00000000-0000-4000-8000-0000000000aa';
  add('PUT', '/rest/v1/roster', { query: { id: `eq.${putRow}` }, body: { id: putRow, company_id: A.id, first_name: 'Morgan', last_name: 'Tate', title: 'Welder', role: 'employee', active: true } });
  add('PATCH', '/rest/v1/companies', { query: { id: `eq.${A.id}`, select: 'id' }, headers: { Prefer: 'return=representation' }, body: { name: A.name } });
  add('PATCH', '/rest/v1/notifications', { query: { id: `in.(${NOWHERE})` }, body: { read_at: '2026-11-18T00:00:00.000Z' } });

  // Functions that read.
  for (const name of ['my_companies', 'my_join_requests', 'member_company_ids', 'supervisor_company_ids', 'records_open_company_ids']) rpc(name);
  rpc('is_member', { company_id: A.id });
  rpc('is_supervisor', { company_id: A.id });
  rpc('company_billing', { p_company_id: A.id });
  // The code lookup, as the dashboard makes it for a signed-in account that has joined nothing
  // (dashboard/src/lib/api.ts). Nobody signed out may make it since migration 20261122000100: it
  // is a signed-in account's read, like those above.
  rpc('company_by_code', { code: B.joinCode });
  add('GET', '/rest/v1/rpc/company_by_code', { query: { code: B.joinCode } });

  // Functions that write. The second company's code, because the account that gets the whole
  // policy is already in the first, and join_company answers a member before it reads the name.
  const revOf = (record) => createHash('sha1').update(JSON.stringify(record)).digest('hex').slice(0, 20);
  const change = (kind, id, record) => ({ key: `${kind}:${id}`, kind, id, rev: revOf(record), record });
  rpc('join_company', { code: B.joinCode, first_name: 'Sam', last_name: 'Ortiz' });
  rpc('create_company', { name: 'Test Pit D', state: 'NV', timezone: 'America/Los_Angeles', first_name: 'Sam', last_name: 'Ortiz', title: 'Owner' });
  rpc('approve_join_request', { request_id: request, roster_id: a3Row, role: 'employee', title: 'Laborer', replace_claim: false });
  rpc('deny_join_request', { request_id: request, bar: false });
  rpc('lift_join_bar', { request_id: request });
  rpc('release_roster_claim', { roster_id: a3Row });
  rpc('rotate_join_code', { company_id: A.id });
  rpc('push_records', { company_id: A.id, changes: [change('equipment', 'eq-scan-1', { id: 'eq-scan-1', unit: 'L-22', category: 'loader', status: 'ready', meter: 40 })] });
  rpc('submit_contact_request', { p_name: 'Robin Hale', p_company: 'Test Pit E', p_email: 'robin.hale@example.test', p_phone: '555-0101', p_message: 'Please send the price list.', p_website: '' });

  // The GraphQL address. pg_graphql is off in the image, as on a new project, so this is answered
  // with a refusal. It is here because the gateway routes it and the description does not list it.
  add('POST', '/graphql/v1', { body: { query: '{ __typename }' } });

  // The webhook, with a signature that cannot match: the function turns it down, which is the
  // only answer a caller without the signing secret can get.
  add('POST', `${webhookBase}/stripe-webhook`, {
    headers: { 'Stripe-Signature': `t=1795000000,v1=${'0'.repeat(64)}` },
    body: { id: 'evt_scan_unsigned', object: 'event', type: 'customer.subscription.updated', created: 1795000000, livemode: false, data: { object: {} } },
  });
  return entries;
}

/** Writes the three files and says what is in them. */
export function writeScanInputs({ home, appId }) {
  const at = layout(home);
  const stack = path.dirname(at.stackEnv);
  const out = inputsFolder(home);
  const read = (name) => JSON.parse(readFileSync(path.join(stack, name), 'utf8'));
  const fixtures = read('fixtures.json');
  const gateway = fixtures.gatewayUrl;
  if (gateway !== LOCAL_SERVER) throw new Error(`The stack's gateway is ${gateway}, not ${LOCAL_SERVER}. Nothing but the local server is ever scanned.`);

  mkdirSync(out, { recursive: true, mode: 0o700 });
  const write = (name, text) => writeFileSync(path.join(out, name), text, { mode: 0o600 });
  const envFile = path.join(out, 'scan.env');
  const application = appId ?? readEnvFile(envFile).APP_ID;
  if (!/^[0-9a-f-]{36}$/.test(application ?? '')) {
    throw new Error('Say which StackHawk application the scans belong to: --app-id <its id>, or set STACKHAWK_APP_ID. "hawk op app list" shows the ids.');
  }

  const key = fixtures.keys.publishable;
  const { A1, A2, B1, N1 } = fixtures.accounts;
  const A = fixtures.companies.A;
  const B = fixtures.companies.B;
  const a3Row = A.roster.A3.rosterId; // On the roster and held by nobody: the one roster row the scanner is given.
  const b1Row = B.roster.B1.rosterId;

  const { description, webhookBase } = mergedDescription(read('openapi-authenticated.gateway.json'), read('openapi-stripe-webhook.json'), madeUpValues(fixtures));
  const entries = seedRequests({ gateway, key, fixtures, webhookBase });

  const vars = {
    APP_ID: application,
    SCAN_PUBLISHABLE_KEY: key,
    SCAN_A1_EMAIL: A1.email, SCAN_A1_PASSWORD: A1.password,
    SCAN_A2_EMAIL: A2.email, SCAN_A2_PASSWORD: A2.password,
    SCAN_B1_EMAIL: B1.email, SCAN_B1_PASSWORD: B1.password,
    SCAN_N1_EMAIL: N1.email, SCAN_N1_PASSWORD: N1.password,
    SCAN_COMPANY_A: A.id, SCAN_COMPANY_A_EQ: `eq.${A.id}`,
    SCAN_COMPANY_B: B.id, SCAN_COMPANY_B_EQ: `eq.${B.id}`,
    SCAN_ROSTER_A3: a3Row, SCAN_ROSTER_A3_EQ: `eq.${a3Row}`,
    SCAN_ROSTER_B1: b1Row,
    SCAN_REQUEST_P1: fixtures.pendingJoinRequest.id,
    SCAN_CODE_B: B.joinCode,
    SCAN_OUTBOUND_PROXY: GUARD_URL,
    SCAN_GUARD_HOST: GUARD_HOST,
    SCAN_GUARD_PORT: String(GUARD_PORT),
    OPENAPI_SCAN: path.join(out, 'openapi-scan.json'),
    SEED_HAR: path.join(out, 'api-seed.har'),
  };
  write('scan.env', `${Object.entries(vars).map(([name, value]) => `${name}=${shellQuoted(value)}`).join('\n')}\n`);
  write('openapi-scan.json', `${JSON.stringify(description, null, 2)}\n`);
  write('api-seed.har', `${JSON.stringify({ log: { version: '1.2', creator: { name: 'scan-inputs.mjs', version: '1' }, entries } }, null, 2)}\n`);

  const pairs = Object.entries(description.paths).flatMap(([name, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${name}`));
  return { folder: out, envFile, variables: Object.keys(vars).length, paths: Object.keys(description.paths).length, pairs, seedRequests: entries.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = readArgs(process.argv.slice(2));
    const made = writeScanInputs({ home: homeFrom(args), appId: typeof args['app-id'] === 'string' ? args['app-id'] : process.env.STACKHAWK_APP_ID });
    console.log(`Wrote scan.env (${made.variables} variables), openapi-scan.json (${made.paths} paths, ${made.pairs.length} method and path pairs) and api-seed.har (${made.seedRequests} requests) in ${made.folder}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
