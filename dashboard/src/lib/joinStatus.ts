import type { JoinResult, RequestStatus } from './server';

/** A sentence's full stop, unless it already ends on one, as "Sample Mining Co." does. */
export const withStop = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * What to tell a person after they type a join code and their name, for each
 * answer `join_company` gives (supabase/README.md, "How someone joins").
 * `open` is true when they are in the company and it can be opened.
 */
export function joinMessage(result: JoinResult): { tone: 'ok' | 'info' | 'warn' | 'bo'; text: string; open: boolean } {
  const company = result.company_name || 'the company';
  switch (result.status) {
    case 'no_company':
      return { tone: 'bo', open: false, text: 'No company has that code. Check the code with a supervisor and type it again.' };
    case 'already_member':
      return { tone: 'ok', open: true, text: withStop(`You are already on the roster of ${company}`) };
    case 'joined':
      return { tone: 'ok', open: true, text: withStop(`You have joined ${company}${result.role === 'supervisor' ? ' as a supervisor' : ''}`) };
    case 'denied':
      return { tone: 'bo', open: false, text: `A supervisor of ${company} has turned your request down. Speak to one of them.` };
    case 'ambiguous':
      return {
        tone: 'warn',
        open: false,
        text: `That name fits more than one person on the roster of ${company}. Type it the way it is written on the roster, with the middle initial or “Jr” if it has one.`,
      };
    case 'pending':
      return { tone: 'info', open: false, text: `Your request to join ${company} is waiting for a supervisor. Once one has let you in, check again here.` };
    default:
      return { tone: 'warn', open: false, text: 'The server gave an answer this page does not know. Reload the page and try again.' };
  }
}

export const REQUEST_STATUS: Record<RequestStatus, string> = {
  pending: 'Waiting for a supervisor',
  approved: 'Let in',
  denied: 'Turned down',
  withdrawn: 'Settled: you joined by yourself, or were taken back on your old row',
};
