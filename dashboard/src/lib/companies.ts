import type { CompanyChoice } from './server';

/** The company to open once the list is loaded again: by id, or by the name the server gave. */
export type OpenWhich = { id?: string; name?: string };

/**
 * Which company to open once the list of the account's companies has been
 * loaded again: the one asked for by id, or else the one with the name the
 * server gave (`join_company` answers with the company's name, not its id).
 * A name two companies share opens neither; the person picks.
 */
export function companyToOpen(list: CompanyChoice[], want?: OpenWhich): string | undefined {
  if (!want) return undefined;
  if (want.id && list.some((c) => c.id === want.id)) return want.id;
  const name = want.name?.trim().toLowerCase();
  if (!name) return undefined;
  const named = list.filter((c) => c.name.trim().toLowerCase() === name);
  return named.length === 1 ? named[0].id : undefined;
}
