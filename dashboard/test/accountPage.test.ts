// The Your account page and its two calls to the server: what it shows for each company before
// anything is deleted, and what it says of each answer. A stand-in for the Supabase client plays the
// server; no request leaves the test. The companies and people are made up.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  check: [] as unknown[],
  signIn: { data: { session: { access_token: 't' } }, error: null } as unknown,
  user: { data: { user: { id: 'u-riley' } }, error: null } as unknown,
  invoke: { data: { deleted: true, closed: [] }, error: null } as unknown,
  invoked: [] as unknown[],
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: async (name: string) => (name === 'account_deletion_check' ? { data: server.check, error: null } : { data: null, error: { code: 'PT404', message: 'No such function.' } }),
    auth: {
      signInWithPassword: async () => server.signIn,
      getUser: async () => server.user,
      signOut: async () => ({ error: null }),
    },
    functions: {
      invoke: async (name: string, options: unknown) => {
        server.invoked.push({ name, options });
        if (server.invoke instanceof Error) throw server.invoke;
        return server.invoke;
      },
    },
  },
}));

const { accountDeletionCheck, deleteMyAccount, DELETE_TIMEOUT_MS } = await import('../src/lib/api');
const { AccountPage, AccountView, canSubmit, deletedWords, DELETED_PATH } = await import('../src/screens/AccountPage');

type View = Parameters<typeof AccountView>[0];
const noop = () => {};
/** The page as drawn once the server has answered, as text and as markup. */
function view(check: View['check'], over: Partial<View> = {}) {
  const html = renderToStaticMarkup(
    createElement(AccountView, {
      email: 'sam@example.com',
      check,
      typed: {},
      password: '',
      busy: false,
      problem: null,
      onRetry: noop,
      onType: noop,
      onPassword: noop,
      onOpen: noop,
      onSubmit: noop,
      ...over,
    }),
  );
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ') };
}
const company = (over: Record<string, unknown>) => ({
  id: 'c-a',
  name: 'Test Pit A',
  role: 'supervisor' as const,
  lastSupervisor: false,
  successors: [] as { rosterId: string; firstName: string; lastName: string }[],
  canClose: false,
  closeFrom: null as string | null,
  running: 0 as number | null,
  ...over,
});

const httpError = (status: number, body: unknown) => ({
  data: null,
  error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => body } },
});
const gone = { data: { user: null }, error: { name: 'AuthApiError', code: 'user_not_found', status: 403, message: 'User from sub claim in JWT does not exist' } };

beforeEach(() => {
  server.check = [];
  server.signIn = { data: { session: { access_token: 't' } }, error: null };
  server.user = { data: { user: { id: 'u-riley' } }, error: null };
  server.invoke = { data: { deleted: true, closed: [] }, error: null };
  server.invoked = [];
});

describe('the page', () => {
  it('opens on checking the account, says who is signed in, and names the page in the browser tab', () => {
    const html = renderToStaticMarkup(createElement(AccountPage, { email: 'riley@example.com', openCompany: null }));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Your account');
    expect(text).toContain('Signed in as riley@example.com.');
    expect(text).toContain('Checking your account');
    // Nothing can be deleted before the server has said what it means.
    expect(html).not.toMatch(/type="password"/);
  });

  it('lets a long address wrap at a phone’s width wherever the page says it: the page may break it anywhere', () => {
    const email = 'riley.j.quinn.night.shift.crusher.operator@example.com';
    const page = '<div class="stack" style="gap:1.5rem;max-width:44rem;overflow-wrap:anywhere">';
    const checking = renderToStaticMarkup(createElement(AccountPage, { email, openCompany: null }));
    const answered = view([], { email }).html;
    for (const html of [checking, answered]) {
      expect(html.startsWith(page)).toBe(true);
      expect(html).toContain(`<p class="lede">Signed in as ${email}.</p>`);
    }
    // Once the server has answered, the address is said three times more: what goes, and the password's label.
    expect(answered.split(email).length - 1).toBe(4);
    expect(answered).toMatch(new RegExp(`<label[^>]*>Password for ${email.replace(/\./g, '\\.')}</label>`));
  });

  it('says on the sign-in page what was done, once the browser is sent there', () => {
    expect(DELETED_PATH).toEqual({ deleted: '/?deleted=1', already: '/?deleted=already' });
    expect(deletedWords('?deleted=1')).toBe('Your account is deleted. This browser is signed out.');
    expect(deletedWords('?deleted=already')).toBe('Your account was deleted already. This browser is signed out.');
    for (const other of ['', '?deleted=0', '?code=abc', '?deleted=<b>']) expect(deletedWords(other)).toBeNull();
  });
});

describe('the page once the server has answered', () => {
  it('lets a crew member delete with the password, saying what goes and what stays', () => {
    const { html, text } = view([company({ role: 'employee', running: null })]);
    expect(text).toContain('Deleting your account deletes your MineMuster sign-in, sam@example.com, and your requests to join a company. It cannot be undone.');
    expect(text).toContain('What is deleted');
    expect(text).toContain('Your name on Test Pit A’s roster, and the records you made, with your name on them.');
    expect(text).toContain('A plain-language summary, not legal advice.');
    expect(html).toMatch(/<label[^>]*>Password for sam@example.com<\/label>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Delete my account<\/button>|<button[^>]*disabled=""[^>]*type="submit"[^>]*>Delete my account<\/button>/);
    // Typed, it can go.
    expect(canSubmit([company({ role: 'employee', running: null })], 'sam@example.com', {}, 'crusher77')).toBe(true);
  });

  it('sends a company’s only supervisor to its Roster page first, with no way to delete until then', () => {
    const { html, text } = view([company({ lastSupervisor: true, successors: [{ rosterId: 'r-lee', firstName: 'Lee', lastName: 'Park' }] })]);
    expect(text).toContain('You are Test Pit A’s only supervisor');
    expect(text).toContain('Make Lee Park a supervisor on Test Pit A’s Roster page, then come back.');
    expect(text).toContain('Open Test Pit A’s Roster page');
    expect(text).toContain('Once that is done, come back to this page to delete your account.');
    expect(html).not.toMatch(/type="password"/);
    expect(canSubmit([company({ lastSupervisor: true, successors: [{ rosterId: 'r', firstName: 'L', lastName: 'P' }] })], 'sam@example.com', {}, 'x')).toBe(false);
  });

  it('says from when a company can be closed, and sends to Billing while a subscription runs', () => {
    expect(view([company({ lastSupervisor: true, closeFrom: '2026-12-20T18:00:00Z' })]).text).toMatch(/Test Pit A can be closed from .*2026/);
    const running = view([company({ lastSupervisor: true, canClose: true, running: 1 })]);
    expect(running.text).toContain('Open Test Pit A’s Billing');
    expect(running.html).not.toMatch(/type="password"/);
  });

  it('lets every button that names a company wrap, so a long name fits a phone (btn-wrap, as on the invitations page)', () => {
    const name = 'Test Pit A Crushed Stone';
    const named = (over: Record<string, unknown>) => view([company({ name, lastSupervisor: true, ...over })]).html;
    const wraps = (html: string, label: string) => new RegExp(`<button[^>]*class="[^"]*\\bbtn-wrap\\b[^"]*"[^>]*>${label}</button>`).test(html);
    expect(wraps(named({ successors: [{ rosterId: 'r-lee', firstName: 'Lee', lastName: 'Park' }] }), `Open ${name}’s Roster page`)).toBe(true);
    expect(wraps(named({ closeFrom: '2026-12-20T18:00:00Z' }), `Open ${name}’s Roster page`)).toBe(true);
    expect(wraps(named({ canClose: true, running: 1 }), `Open ${name}’s Billing`)).toBe(true);
    const closing = named({ canClose: true });
    expect(wraps(closing, `Open ${name}’s Exports`)).toBe(true);
    expect(wraps(closing, `Close ${name} and delete my account`)).toBe(true);
  });

  it('closes a company nobody else can take over only with its name typed and the password', () => {
    const closing = [company({ lastSupervisor: true, canClose: true })];
    const { html, text } = view(closing);
    expect(text).toContain('Nobody else can take over Test Pit A');
    expect(text).toContain('Open Test Pit A’s Exports');
    expect(html).toMatch(/<label[^>]*>Type Test Pit A to close it<\/label>/);
    expect(text).toContain('Test Pit A, and every record of it on MineMuster’s server.');
    expect(text).toContain('Close Test Pit A and delete my account');
    expect(canSubmit(closing, 'sam@example.com', {}, 'crusher77')).toBe(false);
    expect(canSubmit(closing, 'sam@example.com', { 'c-a': 'test pit' }, 'crusher77')).toBe(false);
    expect(canSubmit(closing, 'sam@example.com', { 'c-a': ' test PIT a ' }, '')).toBe(false);
    expect(canSubmit(closing, 'sam@example.com', { 'c-a': ' test PIT a ' }, 'crusher77')).toBe(true);
  });

  it('says what the server answered, and that nothing was deleted when the check failed', () => {
    expect(view([company({ role: 'employee', running: null })], { problem: 'That is not the password for sam@example.com. Try again.' }).html).toMatch(
      /role="alert"[^>]*>That is not the password for sam@example.com. Try again.</,
    );
    const failed = view({ failed: 'MineMuster’s server could not be reached.' });
    expect(failed.text).toContain('Your account could not be checked');
    expect(failed.text).toContain('Nothing has been deleted.');
    expect(failed.text).toContain('Try again');
    expect(canSubmit({ failed: 'x' }, 'sam@example.com', {}, 'crusher77')).toBe(false);
    expect(canSubmit('checking', 'sam@example.com', {}, 'crusher77')).toBe(false);
  });
});

describe('asking the server what deleting means', () => {
  it('reads account_deletion_check, and turns down an answer it does not understand', async () => {
    server.check = [{ id: 'c-a', name: 'Test Pit A', role: 'supervisor', last_supervisor: true, successors: [], can_close: true, close_from: null, running: 0 }];
    expect(await accountDeletionCheck()).toEqual([
      { id: 'c-a', name: 'Test Pit A', role: 'supervisor', lastSupervisor: true, successors: [], canClose: true, closeFrom: null, running: 0 },
    ]);
    server.check = { not: 'a list' } as unknown as unknown[];
    await expect(accountDeletionCheck()).rejects.toThrow(/does not understand/);
  });
});

describe('deleting', () => {
  it('signs in with the password again, then asks the function to delete the account the session is, naming nobody', async () => {
    expect(await deleteMyAccount(' Riley@Example.com ', 'haulroad88', {})).toEqual({ kind: 'deleted', closed: [] });
    expect(server.invoked).toEqual([{ name: 'delete-account', options: { body: {}, timeout: DELETE_TIMEOUT_MS } }]);
    // The companies to close go by id and the name as typed.
    await deleteMyAccount('sam@example.com', 'crusher77', { close: [{ company_id: 'c-c', name: 'test pit c' }] });
    expect(server.invoked[1]).toEqual({ name: 'delete-account', options: { body: { close: [{ company_id: 'c-c', name: 'test pit c' }] }, timeout: DELETE_TIMEOUT_MS } });
  });

  it('says the password is wrong, or that the account was deleted already, and asks the function nothing', async () => {
    server.signIn = { data: { session: null }, error: { name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
    expect(await deleteMyAccount('riley@example.com', 'wrong', {})).toEqual({ kind: 'wrong_password' });
    server.user = gone;
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'already_deleted' });
    server.signIn = { data: { session: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'unreachable' });
    server.signIn = { data: { session: null }, error: { name: 'AuthApiError', code: 'over_request_rate_limit', status: 429, message: 'Too many' } };
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'too_many' });
    expect(server.invoked).toEqual([]);
  });

  it('reads what the function answered, a refused close among them', async () => {
    server.invoke = httpError(409, { error: 'close_refused', company_id: 'c-c', reason: 'wrong_name', close_from: null, closed: [] });
    expect(await deleteMyAccount('sam@example.com', 'crusher77', { close: [{ company_id: 'c-c', name: 'test pit' }] })).toEqual({
      kind: 'close_refused',
      companyId: 'c-c',
      reason: 'wrong_name',
      closeFrom: null,
      closed: [],
    });
    server.invoke = httpError(409, { error: 'last_supervisor', companies: [{ id: 'c-a', name: 'Test Pit A', successors: [] }] });
    expect(await deleteMyAccount('sam@example.com', 'crusher77', {})).toEqual({ kind: 'last_supervisor', companies: ['Test Pit A'] });
    server.invoke = httpError(410, { error: 'already_deleted' });
    expect(await deleteMyAccount('sam@example.com', 'crusher77', {})).toEqual({ kind: 'already_deleted' });
  });

  it('never calls an unclear answer a deletion, or says nothing was deleted, before Supabase Auth has said', async () => {
    // No answer, and the account is gone: deleted.
    server.invoke = new TypeError('Failed to fetch');
    server.user = gone;
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'deleted', closed: [] });
    // No answer, and the account is still there: not known yet.
    server.user = { data: { user: { id: 'u-riley' } }, error: null };
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'not_known', closed: [] });
    // The function turned the session down: still there, so nothing was deleted.
    server.invoke = httpError(401, { error: 'signed_out' });
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'try_again', closed: [] });
    server.invoke = httpError(504, { error: 'not_known', closed: ['c-c'] });
    server.user = gone;
    expect(await deleteMyAccount('riley@example.com', 'haulroad88', {})).toEqual({ kind: 'deleted', closed: ['c-c'] });
  });
});
