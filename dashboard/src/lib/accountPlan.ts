import { legalLine, type DeletionCheckCompany } from '@app/domain/accountDeletion';

/**
 * What the Your account page shows for deleting the signed-in account, from the server's
 * account_deletion_check: what goes, what stays with each company and why, and what each company
 * needs first. Pure, for the page and its tests.
 *
 * A company always keeps a supervisor. Where the person is its only one, either someone else is
 * made a supervisor on that company's Roster page (the page sends them there; it never writes the
 * roster itself), or the company is closed with the account: when nobody else could take over or come
 * back (can_close), with its name typed as it is, and once its subscription is cancelled. Someone taken
 * off its roster in the last 30 days could still be put back, so until then it can be neither.
 */

export type CompanyStep =
  /** Crew there, or a supervisor beside another: the account goes, the company stays as it is. */
  | { kind: 'stays'; company: DeletionCheckCompany }
  /** Its only supervisor, with someone who can take over now: make one of them a supervisor first. */
  | { kind: 'hand_over'; company: DeletionCheckCompany }
  /** Its only supervisor, and only people who left lately stand in the way: from when it can be closed. */
  | { kind: 'wait'; company: DeletionCheckCompany; from: number }
  /** Its only supervisor, nobody else could take over, and a subscription is still charged: cancel it first. */
  | { kind: 'cancel_first'; company: DeletionCheckCompany }
  /** Its only supervisor, nobody else could take over: it is closed with the account, once its name is typed. */
  | { kind: 'close'; company: DeletionCheckCompany };

export interface AccountPlan {
  intro: string;
  deletes: string[];
  keeps: string[];
  legal: string;
  /** One for each company, in the server's order. */
  steps: CompanyStep[];
  warnings: string[];
  /** Something has to be done elsewhere first: the delete is not offered. */
  blocked: boolean;
  /** The companies closed with the account. */
  closes: DeletionCheckCompany[];
}

const possessive = (name: string) => `${name}’s`;
/** "A’s", "A’s and B’s", "A’s, B’s and C’s". */
const possessives = (names: string[]) => {
  const each = names.map(possessive);
  return each.length <= 1 ? each.join('') : `${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}`;
};

export function stepFor(company: DeletionCheckCompany): CompanyStep {
  if (company.role !== 'supervisor' || !company.lastSupervisor) return { kind: 'stays', company };
  if (company.successors.length) return { kind: 'hand_over', company };
  if (!company.canClose) {
    const from = company.closeFrom ? Date.parse(company.closeFrom) : Number.NaN;
    // With no date the server knows of nobody it waits for; nothing here can say more than to hand over.
    return Number.isFinite(from) ? { kind: 'wait', company, from } : { kind: 'hand_over', company };
  }
  if ((company.running ?? 0) > 0) return { kind: 'cancel_first', company };
  return { kind: 'close', company };
}

export function accountPlan(email: string, companies: DeletionCheckCompany[]): AccountPlan {
  const steps = companies.map(stepFor);
  const kept = steps.filter((s) => s.kind !== 'close').map((s) => s.company.name);
  const closes = steps.filter((s): s is Extract<CompanyStep, { kind: 'close' }> => s.kind === 'close').map((s) => s.company);

  const deletes = [
    `Your MineMuster sign-in, ${email}, and its password. It stops working on every phone and on this dashboard.`,
    'Your requests to join a company.',
  ];
  const keeps: string[] = [];
  if (kept.length) {
    keeps.push(
      kept.length > 1
        ? `Your name on ${possessives(kept)} rosters, and the records you made, with your name on them. A supervisor takes your name off when you leave.`
        : `Your name on ${possessive(kept[0])} roster, and the records you made, with your name on them. A supervisor takes your name off when you leave.`,
    );
    keeps.push(
      kept.length > 1
        ? 'MineMuster keeps them for each company while it uses MineMuster, and deletes them when the company asks.'
        : `MineMuster keeps them for ${kept[0]} while it uses MineMuster, and deletes them when the company asks.`,
    );
  }
  keeps.push('An account you made in the MineMuster app on a phone stays on that phone. Delete it there, under More, or delete the app.');

  const warnings: string[] = [];
  for (const c of companies) {
    if (c.role === 'supervisor' && !c.lastSupervisor && (c.running ?? 0) > 0) {
      warnings.push(`${possessive(c.name)} subscription stays with the company. If its invoices come to your email, have another supervisor change the billing email first.`);
    }
  }

  return {
    intro: `Deleting your account deletes your MineMuster sign-in, ${email}, and your requests to join a company. It cannot be undone.`,
    deletes,
    keeps,
    // The time records a company keeps depend on its own settings, which this page does not have for
    // every company: what every company keeps is said, and nothing more. A company closed keeps nothing.
    legal: kept.length ? legalLine(kept[0], false, kept.length > 1) : '',
    steps,
    warnings,
    blocked: steps.some((s) => s.kind === 'hand_over' || s.kind === 'wait' || s.kind === 'cancel_first'),
    closes,
  };
}

/** The words for one company's step, with what to do about it. */
export function stepWords(step: CompanyStep, fmtDay: (ms: number) => string): { title: string; body: string } | null {
  const name = step.company.name;
  switch (step.kind) {
    case 'stays':
      return null;
    case 'hand_over': {
      const who = step.company.successors.map((s) => `${s.firstName} ${s.lastName}`);
      const list = who.length <= 1 ? who.join('') : `${who.slice(0, -1).join(', ')} or ${who[who.length - 1]}`;
      return {
        title: `You are ${possessive(name)} only supervisor`,
        body: who.length
          ? `Someone has to take over before your account is deleted, so the crew can still be let in and the records read. Make ${list} a supervisor on ${possessive(name)} Roster page, then come back.`
          : `Someone has to take over before your account is deleted, so the crew can still be let in and the records read. Make someone a supervisor on ${possessive(name)} Roster page, then come back.`,
      };
    }
    case 'wait':
      return {
        title: `You are ${possessive(name)} only supervisor`,
        body: `Someone taken off ${possessive(name)} roster in the last 30 days could still be put back, so ${name} can be closed from ${fmtDay(step.from)}. Until then, put someone back on the roster and make them a supervisor, on its Roster page.`,
      };
    case 'cancel_first':
      return {
        title: `Nobody else can take over ${name}`,
        body: `${name} is closed with your account, and its subscription is still running. Cancel it in ${possessive(name)} Billing first, then come back.`,
      };
    case 'close':
      return {
        title: `Nobody else can take over ${name}`,
        body: `To delete your account, close the company. Closing deletes ${name} and all its records from MineMuster’s server, for good. Download what the company has to keep first, on its Exports page.`,
      };
  }
}

/** A company's name typed as it is, capitals and spacing aside: the server checks it again. */
export const namedAs = (typed: string, name: string) => {
  const fold = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return fold(typed) !== '' && fold(typed) === fold(name);
};

/** The body the delete-account function takes: the companies to close, by id and the name typed. */
export function deleteBody(closes: DeletionCheckCompany[], typed: Record<string, string>): { close?: { company_id: string; name: string }[] } {
  return closes.length ? { close: closes.map((c) => ({ company_id: c.id, name: typed[c.id] ?? '' })) } : {};
}
