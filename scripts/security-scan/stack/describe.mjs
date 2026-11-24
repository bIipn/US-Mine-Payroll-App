// Writes what the scanner is pointed at: PostgREST's own description of the
// API as anon and as authenticated, a small OpenAPI file for the Stripe
// webhook, and routes.md, the inventory of every table, view and function the
// two roles reach, cross-checked against the running database's catalogs, the
// grants in the migrations and supabase/README.md.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { GATEWAY_URL, HOST, MIGRATIONS, PORTS, REPO, call, signJwt, sql, writePrivate } from './lib.mjs';

const ROLES = ['anon', 'authenticated'];

/** PostgREST's OpenAPI document, asked for directly (not through the gateway) as one role. */
function openapiAs(secrets, role) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/openapi+json', Authorization: `Bearer ${signJwt(secrets, { role }, 120)}` };
    http.get({ host: HOST, port: PORTS.rest, path: '/', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => (response.statusCode === 200 ? resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : reject(new Error(`PostgREST answered ${response.statusCode} as ${role}`))));
    }).on('error', reject);
  });
}

/** The same document, made to fit the gateway: its address, the /rest/v1 prefix, and the two headers a request carries. */
function forGateway(document) {
  return {
    ...document,
    host: `${HOST}:${PORTS.gateway}`,
    basePath: '/rest/v1',
    schemes: ['https'],
    securityDefinitions: {
      apikey: { type: 'apiKey', in: 'header', name: 'apikey', description: 'The publishable key.' },
      bearer: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Bearer <access token> for a signed-in account.' },
    },
    security: [{ apikey: [] }, { apikey: [], bearer: [] }],
  };
}

export const CATALOG_SQL = `
select json_build_object(
  'schemas', (select json_object_agg(s, json_build_object('anon', has_schema_privilege('anon', s, 'usage'), 'authenticated', has_schema_privilege('authenticated', s, 'usage')))
              from unnest(array['public', 'graphql_public']) s),
  'relations', (select coalesce(json_agg(r order by r.schema, r.name), '[]') from (
    select n.nspname as schema, c.relname as name, c.relkind as kind, c.relrowsecurity as rls,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
           (select json_object_agg(who, json_build_object(
              'select', has_table_privilege(who, c.oid, 'select') or has_any_column_privilege(who, c.oid, 'select'),
              'insert', has_table_privilege(who, c.oid, 'insert') or has_any_column_privilege(who, c.oid, 'insert'),
              'update', has_table_privilege(who, c.oid, 'update') or has_any_column_privilege(who, c.oid, 'update'),
              'delete', has_table_privilege(who, c.oid, 'delete')))
            from unnest(array['anon', 'authenticated']) who) as can
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'graphql_public') and c.relkind in ('r', 'v', 'm', 'p', 'f')) r),
  'functions', (select coalesce(json_agg(f order by f.schema, f.name, f.args), '[]') from (
    select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, p.provolatile as volatility,
           p.prosecdef as definer, pg_get_function_result(p.oid) as result,
           has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'graphql_public') and p.prokind = 'f') f));`;

/** What each reachable thing is for, whether a call changes data, and what junk does to the fixtures. Written by hand from supabase/README.md. */
const NOTES = {
  companies: ['Members read their own company. A supervisor changes its name, state, time zone, logo path and pay period (PATCH).', 'PATCH', 'A supervisor\'s junk renames the company or changes its state until a reset. Nobody is locked out.'],
  roster: ['Members read their company\'s roster. A supervisor adds, changes and deletes rows.', 'POST, PATCH, DELETE', 'A supervisor\'s junk can rename or delete rows, change roles, or set A2\'s row inactive, which takes A2 out of the company until a reset. The last supervisor cannot be removed.'],
  join_requests: ['A company\'s supervisors read its requests.', '', 'None: read only.'],
  notifications: ['A company\'s supervisors read them and mark them read (PATCH read_at).', 'PATCH', 'Marks notifications read. Harmless.'],
  records: ['Members read what the crew works from; supervisors read all, while the company has MineMuster.', '', 'None: read only.'],
  record_history: ['Every version of the records the caller may read.', '', 'None: read only.'],
  billing_subscriptions: ['A company\'s supervisors read its subscriptions.', '', 'None: read only.'],
  billing_overrides: ['A company\'s supervisors read its override.', '', 'None: read only.'],
  company_by_code: ['A signed-in account: the name and state of the company with this join code. Nobody signed out may call it (migration 20261122000100): the crew sign-in looks a code up through the crew-auth function, with the server key.', '', 'None. Nothing yet limits how often a signed-in account tries codes; the crew sign-in\'s lookup is limited to 30 tries from one address in 10 minutes.'],
  submit_contact_request: ['Anyone: the website\'s contact form.', 'yes', 'Keeps a row for each message. Its limits (3 from one email address in 24 hours, 5 from one sender in an hour, 100 from everyone in an hour) then answer 429 to everyone until a reset.'],
  create_company: ['A signed-in account starts a company and becomes its supervisor.', 'yes', 'Every call makes a company, up to 3 in 24 hours and 20 in all for one account; past either it answers that account 429 until a reset. A1 and B1 have started one each.'],
  join_company: ['A signed-in account joins a company with its code and a name.', 'yes', 'With company A\'s code a junk name leaves a pending request; the name on A3\'s row claims that row. Both change the fixtures until a reset.'],
  approve_join_request: ['A supervisor lets a request in.', 'yes', 'As A1 with P1\'s request it makes P1 a member and uses up the pending request.'],
  deny_join_request: ['A supervisor turns a request down, with a bar or without.', 'yes', 'As A1 it closes P1\'s request; with bar it keeps P1 out until lift_join_bar or a reset.'],
  lift_join_bar: ['A supervisor lifts a bar.', 'yes', 'Only after a bar. Harmless.'],
  rotate_join_code: ['A supervisor gives the company a new join code.', 'yes', 'As A1 or B1 it changes the join code in fixtures.json until a reset.'],
  release_roster_claim: ['A supervisor lets go of the account on a roster row.', 'yes', 'As A1 on A2\'s row it takes A2 out of company A and holds the account until a reset.'],
  my_join_requests: ['The caller\'s own join requests.', '', 'None: read only.'],
  my_companies: ['The companies the caller belongs to.', '', 'None: read only.'],
  is_member: ['Whether the caller is a member of a company.', '', 'None: read only.'],
  is_supervisor: ['Whether the caller is a supervisor of a company.', '', 'None: read only.'],
  member_company_ids: ['The caller\'s companies (the policies call it).', '', 'None: read only.'],
  supervisor_company_ids: ['The companies the caller supervises (the policies call it).', '', 'None: read only.'],
  records_open_company_ids: ['The caller\'s companies whose records it reads (the policies call it).', '', 'None: read only.'],
  company_billing: ['A supervisor: where the company\'s billing stands.', '', 'None: read only.'],
  push_records: ['A member sends up to 200 record changes.', 'yes', 'Writes records and history that nothing removes but a reset. An account that sends 20,000 versions or 64 MB in a day has later sends deferred until a reset.'],
};

/** Supabase Auth's routes behind /auth/v1. Listed by hand from its documentation and then tried once each. */
const AUTH_ROUTES = [
  ['GET', '/auth/v1/health', 'the key', '', 'None.'],
  ['GET', '/auth/v1/settings', 'the key', '', 'None.'],
  ['POST', '/auth/v1/signup', 'the key', 'yes', 'Makes an account for each new email address ("confirm email" is off). Limited by caller address.'],
  ['POST', '/auth/v1/token?grant_type=password', 'the key', 'yes', 'A wrong password changes nothing on the account, but sign-ins are limited by caller address: enough junk stops every sign-in from this machine (429) for some minutes, or until a reset.'],
  ['POST', '/auth/v1/token?grant_type=refresh_token', 'the key', 'yes', 'Uses up a refresh token. Same limit as sign-in.'],
  ['GET', '/auth/v1/user', 'a signed-in account', '', 'None.'],
  ['PUT', '/auth/v1/user', 'a signed-in account', 'yes', 'Changes the account\'s own email address, password or metadata: a junk password locks that fixture account out until a reset.'],
  ['POST', '/auth/v1/logout', 'a signed-in account', 'yes', 'Ends the account\'s sessions: the token used stops refreshing. Sign in again.'],
  ['POST', '/auth/v1/recover', 'the key', 'yes', 'Tries to send mail, which this stack cannot. No lock-out.'],
  ['POST', '/auth/v1/otp', 'the key', 'yes', 'Tries to send mail; may make an account. Limited by caller address.'],
  ['POST', '/auth/v1/magiclink', 'the key', 'yes', 'As /otp.'],
  ['POST', '/auth/v1/resend', 'the key', 'yes', 'Tries to send mail.'],
  ['POST', '/auth/v1/verify', 'anyone (no key)', 'yes', 'Checks a one-time code. Limited by caller address.'],
  ['GET', '/auth/v1/verify', 'anyone (no key)', 'yes', 'The same, from a link in an email.'],
  ['GET', '/auth/v1/authorize', 'anyone (no key)', '', 'Starts a sign-in with a provider. None is turned on here.'],
  ['GET', '/auth/v1/callback', 'anyone (no key)', '', 'A provider\'s way back. None is turned on here.'],
  ['GET', '/auth/v1/.well-known/jwks.json', 'anyone (no key)', '', 'The public half of the signing key.'],
  ['POST', '/auth/v1/reauthenticate', 'a signed-in account', 'yes', 'Tries to send mail.'],
  ['GET', '/auth/v1/factors', 'a signed-in account', '', 'None.'],
  ['POST', '/auth/v1/factors', 'a signed-in account', 'yes', 'Enrols a second factor on the account. Unverified, it does not stop a sign-in.'],
  ['GET', '/auth/v1/admin/users', 'the secret key', '', 'Every account. Refused to the publishable key.'],
];

const routeOf = (relation) => `/rest/v1/${relation}`;

export async function describe(secrets, files) {
  const documents = {};
  for (const role of ROLES) documents[role] = await openapiAs(secrets, role);
  writePrivate(files.openapiAnon, `${JSON.stringify(documents.anon, null, 2)}\n`);
  writePrivate(files.openapiAuthenticated, `${JSON.stringify(documents.authenticated, null, 2)}\n`);
  writePrivate(files.openapiAnonGateway, `${JSON.stringify(forGateway(documents.anon), null, 2)}\n`);
  writePrivate(files.openapiAuthenticatedGateway, `${JSON.stringify(forGateway(documents.authenticated), null, 2)}\n`);
  writePrivate(files.openapiWebhook, `${JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'MineMuster stripe-webhook (local scan stack)', version: '1', description: 'The edge function Stripe sends its events to. It takes no Supabase key or token: Stripe\'s signature is the check.' },
    servers: [{ url: `${GATEWAY_URL}/functions/v1` }],
    paths: { '/stripe-webhook': { post: {
      summary: 'Hand over one Stripe event',
      parameters: [{ name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' }, description: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the signing secret>' }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id', 'type'], properties: {
        id: { type: 'string' }, object: { type: 'string' }, type: { type: 'string' }, created: { type: 'integer' }, livemode: { type: 'boolean' }, data: { type: 'object' } } } } } },
      responses: {
        200: { description: 'What apply_stripe_event did with the event: {applied, ...} or {applied: false, reason}.' },
        400: { description: 'The signature is missing, malformed, too old or does not match; or the body is not a Stripe event.' },
        405: { description: 'Not a POST.' },
        500: { description: 'The webhook is not set up, or the database could not take the event.' },
      } } } },
  }, null, 2)}\n`);

  const catalog = JSON.parse(sql(CATALOG_SQL));
  const migrations = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort().map((name) => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')).join('\n');
  const readme = fs.readFileSync(path.join(REPO, 'supabase/README.md'), 'utf8');
  const granted = (pattern) => new RegExp(pattern, 'im').test(migrations);

  const rows = [];
  const count = { anon: { relations: 0, functions: 0, routes: 0 }, authenticated: { relations: 0, functions: 0, routes: 0 } };
  const expected = { anon: new Set(), authenticated: new Set() };
  const surprises = [];
  for (const relation of catalog.relations) {
    const who = ROLES.filter((role) => catalog.schemas[relation.schema][role] && Object.values(relation.can[role]).some(Boolean));
    if (!who.length) continue;
    const [what = 'NOT DESCRIBED HERE: check it.', changes = '?', junk = '?'] = NOTES[relation.name] ?? [];
    for (const role of who) {
      const can = relation.can[role];
      const methods = [can.select && 'GET', can.insert && 'POST', can.update && 'PATCH', can.insert && can.update && 'PUT', can.delete && 'DELETE'].filter(Boolean);
      count[role].relations += 1;
      count[role].routes += methods.length;
      if (relation.schema === 'public') expected[role].add(`/${relation.name}`);
      rows.push([methods.join(', '), routeOf(relation.name), role, changes ? `yes (${changes})` : 'no', what, junk, `${relation.kind === 'r' ? 'table' : 'view'}${relation.rls ? `, RLS on, ${relation.policies} policies` : ', RLS OFF'}`]);
      if (!granted(`grant [^;]*on table public\\.${relation.name} to [^;]*\\b${role}\\b`)) surprises.push(`${role} reaches table ${relation.schema}.${relation.name} with no grant to it in the migrations (a default privilege).`);
    }
    if (!readme.includes(`\`${relation.name}\``) && !readme.includes(`### ${relation.name}\n`)) surprises.push(`Table ${relation.schema}.${relation.name} is reachable and supabase/README.md does not name it.`);
    if (!relation.rls) surprises.push(`Table ${relation.schema}.${relation.name} is reachable and has row level security off.`);
  }
  for (const fn of catalog.functions) {
    const who = ROLES.filter((role) => catalog.schemas[fn.schema][role] && fn[role]);
    if (!who.length) continue;
    const [what = 'NOT DESCRIBED HERE: check it.', changes = '?', junk = '?'] = NOTES[fn.name] ?? [];
    const methods = fn.volatility === 'v' ? ['POST'] : ['GET', 'POST'];
    const route = fn.schema === 'public' ? `/rest/v1/rpc/${fn.name}` : `/rest/v1/rpc/${fn.name} with Content-Profile: ${fn.schema} (also /graphql/v1)`;
    for (const role of who) {
      count[role].functions += 1;
      count[role].routes += methods.length;
      if (fn.schema === 'public') expected[role].add(`/rpc/${fn.name}`);
      rows.push([methods.join(', '), route, role, changes ? 'yes' : 'no', what, junk, `function(${fn.args}) returns ${fn.result}${fn.definer ? ', security definer' : ''}`]);
      if (fn.schema === 'public' && !granted(`grant execute on function public\\.${fn.name}\\([^;]*\\) to [^;]*\\b${role}\\b`)) surprises.push(`${role} may call ${fn.schema}.${fn.name}(${fn.args}) with no grant to it in the migrations (a default privilege, or PUBLIC).`);
    }
    if (!readme.includes(`\`${fn.name}`)) surprises.push(`Function ${fn.schema}.${fn.name}(${fn.args}) is callable by ${who.join(' and ')} and supabase/README.md does not name it.`);
  }

  // PostgREST's description against the catalogs, for the default schema (public).
  const mismatches = [];
  for (const role of ROLES) {
    const listed = new Set(Object.keys(documents[role].paths).filter((key) => key !== '/'));
    for (const key of listed) if (!expected[role].has(key)) mismatches.push(`As ${role}, PostgREST lists ${key}, which the catalogs do not give ${role}.`);
    for (const key of expected[role]) if (!listed.has(key)) mismatches.push(`As ${role}, the catalogs give ${key}, which PostgREST does not list.`);
  }

  const probes = [];
  for (const [method, route, who, changes, junk] of AUTH_ROUTES) {
    const answer = await call(method, route, { key: who === 'anyone (no key)' ? undefined : secrets.publishableKey, body: method === 'GET' ? undefined : {} });
    probes.push(`| ${method} | \`${route}\` | ${who} | ${changes ? 'yes' : 'no'} | ${junk} | ${answer.status} |`);
  }

  const table = (role) => rows.filter((row) => row[2] === role).map((row) => `| ${row[0]} | \`${row[1]}\` | ${row[3]} | ${row[4]} | ${row[5]} | ${row[6]} |`).join('\n');
  const head = '| Methods | Path | Changes data | What it is, and who gets an answer | What junk does to the fixtures | In the database |\n|---|---|---|---|---|---|';
  const info = documents.anon.info ?? {};
  const text = `# Routes of the local scan stack

Written by \`scripts/security-scan/stack/describe.mjs\` from the running database's catalogs, PostgREST's own description and the migrations, on ${new Date().toISOString()}. Every path is under \`${GATEWAY_URL}\`. The names and ids in the stack are made up.

Every request to \`/rest/v1\` and \`/auth/v1\` carries the publishable key in \`apikey\`. With no \`Authorization\` header it runs as \`anon\`; with a signed-in account's access token it runs as \`authenticated\`, as that account. Row level security and each function's own check then decide what the account gets, so "authenticated" below means "may send the request", not "gets data".

## Counts

| Role | Tables and views | Functions | Method and path pairs |
|---|---|---|---|
| anon | ${count.anon.relations} | ${count.anon.functions} | ${count.anon.routes} |
| authenticated | ${count.authenticated.relations} | ${count.authenticated.functions} | ${count.authenticated.routes} |

A table counts one pair for each of GET, POST, PATCH, PUT and DELETE the role has the privilege for (HEAD goes with GET, and PUT needs both insert and update). A function counts POST, and GET as well unless it is volatile. PostgREST also answers OPTIONS on each.

To count them again, as the database's superuser (\`docker exec -i mm-scan-db psql -U supabase_admin -h 127.0.0.1 -p ${PORTS.db} -d postgres\`):

\`\`\`sql
-- tables and views a role reaches in the schemas PostgREST serves
select r.rolname, count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
where n.nspname in ('public', 'graphql_public') and c.relkind in ('r', 'v', 'm', 'p', 'f') and has_schema_privilege(r.rolname, n.oid, 'usage')
  and (has_table_privilege(r.rolname, c.oid, 'select, insert, update, delete') or has_any_column_privilege(r.rolname, c.oid, 'select, insert, update'))
group by 1;
-- functions a role may call there
select r.rolname, count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
where n.nspname in ('public', 'graphql_public') and p.prokind = 'f' and has_schema_privilege(r.rolname, n.oid, 'usage') and has_function_privilege(r.rolname, p.oid, 'execute')
group by 1;
\`\`\`

And from PostgREST's description: \`jq '.paths | keys | length' openapi-anon.json\` gives ${Object.keys(documents.anon.paths).length} (the root \`/\` and ${Object.keys(documents.anon.paths).length - 1} more), and for \`openapi-authenticated.json\` ${Object.keys(documents.authenticated.paths).length}. From the migrations: \`grep -c "^grant " supabase/migrations/*.sql\`.

## What the description files declare

\`openapi-anon.json\` and \`openapi-authenticated.json\` are PostgREST's own (Swagger ${documents.anon.swagger ?? '2.0'}, PostgREST ${info.version ?? '?'}), asked for directly on port ${PORTS.rest} with a token for the role. They declare host \`${documents.anon.host}\`, basePath \`${documents.anon.basePath}\` and schemes \`${JSON.stringify(documents.anon.schemes)}\`: the address PostgREST itself listens on, not the gateway. A path \`/roster\` there is \`${GATEWAY_URL}/rest/v1/roster\` at the gateway, and \`/rpc/join_company\` is \`${GATEWAY_URL}/rest/v1/rpc/join_company\`. The two \`.gateway.json\` files are the same documents with host \`${HOST}:${PORTS.gateway}\`, basePath \`/rest/v1\`, scheme https and the two headers declared, ready for a scanner. PostgREST follows the role's privileges in these (its \`openapi-mode\` default), so each lists what that role reaches in schema \`public\`. Through the gateway the description itself (\`GET /rest/v1/\`) is refused to the publishable key (403); the secret key gets it.

\`openapi-stripe-webhook.json\` is written by hand (OpenAPI 3.0.3): server \`${GATEWAY_URL}/functions/v1\`, one path, \`POST /stripe-webhook\`.

## anon: the publishable key and nobody signed in

${head}
${table('anon')}

## authenticated: a signed-in account

${head}
${table('authenticated')}

## Supabase Auth, behind /auth/v1

Not in PostgREST's description. Listed by hand from Supabase Auth's documentation, then each tried once with an empty body (the last column is the status it gave here, so 400, 401, 403 and 422 mean "there, and it refused the empty request", and 404 would mean it is not there).

| Method | Path | Who | Changes data | What junk does | Status when tried |
|---|---|---|---|---|---|
${probes.join('\n')}

## The edge function

| Method | Path | Who | Changes data | What junk does |
|---|---|---|---|---|
| POST | \`/functions/v1/stripe-webhook\` | Anyone: no key, no token. Only a body signed with the signing secret is taken. | yes, for a signed event | An unsigned or badly signed request changes nothing and reads nothing from the database. Every other method answers 405. |

## Other paths the gateway answers

\`/graphql/v1\` goes to PostgREST's \`/rpc/graphql\` in schema \`graphql_public\`. \`/storage/v1/\` and \`/realtime/v1/\` are not run here and answer 404. Anything else answers 404 \`{"error":"requested path is invalid"}\`.

## Cross-checks

PostgREST's description against the catalogs (schema \`public\`): ${mismatches.length ? `\n\n${mismatches.map((line) => `- ${line}`).join('\n')}` : 'they agree for both roles.'}

Reachable, and either not granted by a migration, not named in supabase/README.md, or without row level security: ${surprises.length ? `\n\n${[...new Set(surprises)].map((line) => `- ${line}`).join('\n')}` : 'nothing.'}

Schemas: anon has usage on ${Object.entries(catalog.schemas).filter(([, can]) => can.anon).map(([name]) => `\`${name}\``).join(' and ') || 'none'}; authenticated on ${Object.entries(catalog.schemas).filter(([, can]) => can.authenticated).map(([name]) => `\`${name}\``).join(' and ') || 'none'}.
`;
  writePrivate(files.routes, text);
  process.stdout.write(`Wrote the descriptions and ${files.routes}: anon ${count.anon.routes} routes, authenticated ${count.authenticated.routes}; ${mismatches.length} mismatch(es), ${new Set(surprises).size} thing(s) to look at.\n`);
  return { count, mismatches, surprises: [...new Set(surprises)] };
}
