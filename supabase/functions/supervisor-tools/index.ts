// The supervisor-tools edge function: on the office dashboard's Roster page, a supervisor invites another
// supervisor by email, sends an invitation again, and deletes a crew member's passcode sign-in, which need
// Supabase Auth's admin API. What it does is in handler.ts. Deploy it with JWT verification off (a
// browser's preflight carries no token, and the function asks Supabase Auth about the token itself),
// together with ../_shared/server.ts and ../_shared/http.ts.

import { makeHandler } from './handler.ts';

// Deno's own types, as far as this file uses them, so the file also reads as plain TypeScript outside Deno.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

Deno.serve(
  makeHandler({
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    log: (message) => console.error(message),
  }),
);
