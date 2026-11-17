import type { Synced } from './sync';
import type { Role } from './types';

/**
 * The company server a build names, and the one company a phone sends to.
 *
 * The server is a Supabase project (`supabase/`). A person signs in there with
 * an email and a password, joins their company with its join code and their
 * name as it is on the roster, and from then on the phone sends its records to
 * that company. This file is in every build; what was typed and what the server
 * answered are read in `serverAnswers.ts`, which only a build with a server has.
 */

/** The company server a build sends to: a Supabase project's address and its publishable key. */
export interface ServerConfig {
  url: string;
  key: string;
}

/**
 * The server a build names, or none. Both settings are needed; with either one
 * empty the build has no server and nothing about one is loaded or shown. The
 * address is a Supabase project's, `https://<project>.supabase.co`.
 */
export function parseServer(url: string | null | undefined, key: string | null | undefined): { server: ServerConfig | null; error?: string } {
  const address = (url ?? '').trim().replace(/\/+$/, '');
  const publishable = (key ?? '').trim();
  if (!address || !publishable) return { server: null };
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(address)) {
    return { server: null, error: `EXPO_PUBLIC_SUPABASE_URL should be the project's address, like https://example.supabase.co. This build sends to no server.` };
  }
  if (isSecretKey(publishable)) {
    return {
      server: null,
      error: 'EXPO_PUBLIC_SUPABASE_KEY is a secret key, which gets past every rule the server keeps and must never be in an app. Use the project\'s publishable key. This build sends to no server.',
    };
  }
  return { server: { url: address, key: publishable } };
}

/**
 * A key that must never be built into an app: a secret key, or one of the
 * older JWT keys made for the service role. Either one passes over the
 * server's row level security, and anyone with the app could read it out.
 */
function isSecretKey(key: string): boolean {
  if (/^sb_secret_/i.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const json = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(decodeBase64(json)) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 to text, by hand: neither `atob` nor `Buffer` is on every platform the app runs on. A key's payload is ASCII. */
function decodeBase64(text: string): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const ch of text.replace(/=+$/, '')) {
    const n = BASE64.indexOf(ch);
    if (n < 0) throw new Error('Not base64');
    value = ((value << 6) | n) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

/** The company this phone sends its records to. Kept on the phone and nowhere else. */
export interface ConnectedCompany {
  id: string;
  name: string;
  /** The person's role on the company's roster on the server. */
  role: Role;
  /**
   * The server account the phone joined the company with, and its email. The
   * phone sends only while that account is signed in: another account is
   * checked against the company's roster first.
   */
  userId?: string;
  email?: string;
}

/**
 * Why this phone cannot be connected to a company, or null when it can.
 * A phone sends to one company: once its records have gone to one, they are
 * never sent to another, so one company's punches cannot end up with another's.
 */
export function connectProblem(syncedWith: string | null, synced: Synced, companyId: string): string | null {
  if (syncedWith && syncedWith !== companyId && Object.keys(synced).length > 0) {
    return 'This phone has already sent its records to another company, and a phone sends to one company only. To move it, a supervisor clears this device on the More screen first. Records it has not sent yet are lost.';
  }
  return null;
}

/**
 * Whether the company a phone is about to send to is another than the one it
 * holds: the build was made for one company, or a supervisor named it, and the
 * server's company has another name. The person is asked first, since the
 * phone's roster, area sheets and company settings would go there too. A phone
 * that names no company is not asked.
 */
export function otherCompany(held: string, joining: string): boolean {
  // Letters and numbers only, so "Test Pit A, Inc." and "test pit a inc" are one name. Letters past ASCII are kept as they are.
  const plain = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[^0-9a-z\u00c0-\uffff]+/g, ' ').trim();
  return !!plain(held) && plain(held) !== plain(joining);
}
