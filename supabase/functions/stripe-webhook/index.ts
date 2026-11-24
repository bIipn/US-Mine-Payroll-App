// The stripe-webhook edge function: where Stripe sends MineMuster's events.
// What it does is in handler.ts, and how Stripe's signature is checked in
// verify.ts. Deploy it with JWT verification off (Stripe sends no Supabase
// token; the signature is the check): see supabase/README.md.

import { makeHandler } from './handler.ts';

// Deno's own types, as far as this file uses them, so the file also reads as
// plain TypeScript outside Deno.
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
