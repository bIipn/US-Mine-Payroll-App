// The crew-auth edge function: in the app, with no email, a crew member signs up, signs in, sets a new
// passcode with a supervisor's reset code, and confirms their passcode before deleting their account.
// What it does is in handler.ts. Deploy it with JWT verification off (someone signing up or in has no
// token yet, and the function asks Supabase Auth about confirm's token itself), together with
// ../_shared/server.ts and ../_shared/http.ts.

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
