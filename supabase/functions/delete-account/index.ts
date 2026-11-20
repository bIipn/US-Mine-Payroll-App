// The delete-account edge function: a person deletes their own MineMuster sign-in, from the app or
// the office dashboard. What it does is in handler.ts. Deploy it with JWT verification off (a
// browser's preflight carries no token, and the function asks Supabase Auth about the token itself),
// together with ../_shared/server.ts: see supabase/README.md.

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
