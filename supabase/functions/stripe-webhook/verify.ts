// Checking Stripe's signature on a webhook request, the way Stripe documents
// it (https://docs.stripe.com/webhooks#verify-manually), with Web Crypto only:
// no Stripe SDK, so it runs the same in Supabase's Deno runtime and in Node,
// where the tests run it.
//
// Stripe sends a Stripe-Signature header such as
//
//   t=1492774577,v1=5257a869e7ec...,v1=0b8e2a1f...,v0=6ffbb59b2300...
//
// t is when Stripe signed the request, in Unix seconds. Each v1 is the
// HMAC-SHA256, in hex, of `${t}.${raw body}` under the endpoint's signing
// secret (whsec_...). There can be more than one v1 while a secret is being
// rolled; any one that matches will do. v0 and any other scheme are ignored.
//
// The body is taken as the raw bytes Stripe sent, never re-encoded: a body
// that went through JSON.parse and back would not match. A timestamp more than
// the tolerance (five minutes) away from now is refused, so a request someone
// captured cannot be played back later; within it, the event's id keeps a
// replay from being applied twice (apply_stripe_event).
//
// Only erasable TypeScript here, so Node runs the file as it is.

export const TOLERANCE_SECONDS = 300;

export interface StripeSignature {
  /** When Stripe signed it, in Unix seconds. */
  timestamp: number;
  /** Every v1 signature, as 32 bytes each. */
  signatures: Uint8Array[];
}

export type Verdict =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'no_header' | 'malformed_header' | 'no_v1_signature' | 'outside_tolerance' | 'no_secret' | 'mismatch' };

const HEX = /^[0-9a-f]{64}$/i;
const MAX_HEADER = 8192;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * The timestamp and v1 signatures of a Stripe-Signature header, or null when
 * it is not one: no single whole-number t, or nothing but signatures that are
 * not 64 hex characters. A header with a t and no v1 gives an empty list.
 */
export function parseSignatureHeader(header: string | null | undefined): StripeSignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_HEADER) return null;
  let timestamp: number | null = null;
  let timestamps = 0;
  const signatures: Uint8Array[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') {
      timestamps += 1;
      timestamp = /^\d{1,12}$/.test(value) ? Number(value) : null;
    } else if (key === 'v1' && HEX.test(value)) {
      signatures.push(hexToBytes(value));
    }
  }
  if (timestamps !== 1 || timestamp === null) return null;
  return { timestamp, signatures };
}

/** Whether two byte strings are the same, taking as long whichever byte differs. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** HMAC-SHA256 of `${timestamp}.` and the body's bytes, under the secret. */
export async function signatureFor(secret: string, timestamp: number, payload: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + payload.length);
  signed.set(prefix, 0);
  signed.set(payload, prefix.length);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
}

/**
 * Whether the header is the timing only (checked before the secret is
 * needed): a header Stripe could have sent, signed within the tolerance of
 * `now` (Unix seconds).
 */
export function checkHeader(header: string | null | undefined, now: number, tolerance = TOLERANCE_SECONDS): Verdict & { parsed?: StripeSignature } {
  if (typeof header !== 'string' || header.trim() === '') return { ok: false, reason: 'no_header' };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_header' };
  if (parsed.signatures.length === 0) return { ok: false, reason: 'no_v1_signature' };
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'outside_tolerance' };
  return { ok: true, timestamp: parsed.timestamp, parsed };
}

/**
 * Whether Stripe signed this body with this secret, within the tolerance of
 * `now` (Unix seconds; the clock by default).
 */
export async function verifyStripeSignature({
  payload,
  header,
  secret,
  now = Math.floor(Date.now() / 1000),
  tolerance = TOLERANCE_SECONDS,
}: {
  payload: Uint8Array | string;
  header: string | null | undefined;
  secret: string | null | undefined;
  now?: number;
  tolerance?: number;
}): Promise<Verdict> {
  const timing = checkHeader(header, now, tolerance);
  if (!timing.ok) return timing;
  if (typeof secret !== 'string' || secret.trim() === '') return { ok: false, reason: 'no_secret' };
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const expected = await signatureFor(secret.trim(), timing.timestamp, body);
  let matched = false;
  // Every signature is compared, so the time taken says nothing about which one matched.
  for (const signature of timing.parsed!.signatures) matched = sameBytes(expected, signature) || matched;
  return matched ? { ok: true, timestamp: timing.timestamp } : { ok: false, reason: 'mismatch' };
}
