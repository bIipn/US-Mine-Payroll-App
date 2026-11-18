// What up.mjs works out after a scan from the logs this machine keeps: what the local server
// answered, table by table, and what the scan guard passed and refused. It reads lines it is
// given and opens nothing.

/**
 * The local server's answers to the tables, by method and table, from the gateway's log lines
 * ("<time> <method> <path and query> <status> <route>"). Every recorded request that reads a table
 * names its columns with "select", and the description's reads do not, so a 2xx to a read without
 * "select" is a read built from the description that reached the rows.
 */
export function tableAnswers(lines) {
  const found = {};
  for (const line of lines) {
    const match = /^\S+ ([A-Z]+) \/rest\/v1\/([a-z_]+)(\?\S*)? (\d{3}) /.exec(line);
    if (!match) continue;
    const [, method, table, query = '', status] = match;
    const entry = (found[`${method} /rest/v1/${table}`] ??= { requests: 0, ok: 0, okFromTheDescription: 0, byStatus: {} });
    entry.requests++;
    entry.byStatus[status] = (entry.byStatus[status] ?? 0) + 1;
    if (status.startsWith('2')) {
      entry.ok++;
      if (method === 'GET' && !/[?&]select=/.test(query)) entry.okFromTheDescription++;
    }
  }
  return found;
}

/** One line for each table and method, for run.txt, and what they say together. */
export function describeTableAnswers(found) {
  const lines = Object.entries(found).sort(([a], [b]) => a.localeCompare(b)).map(([pair, entry]) => {
    const statuses = Object.entries(entry.byStatus).map(([status, n]) => `${status}:${n}`).join(',');
    return `${pair} ${statuses}${pair.startsWith('GET ') ? ` (2xx to a read from the description: ${entry.okFromTheDescription})` : ''}`;
  });
  const reads = Object.entries(found).filter(([pair]) => pair.startsWith('GET '));
  let verdict;
  if (reads.length === 0) verdict = 'No table was read at all: the tables were not scanned.';
  else if (reads.every(([, entry]) => entry.ok === 0)) verdict = 'No table read was answered 2xx: neither the recorded requests nor the description reached a row, so the tables were not scanned.';
  else if (reads.every(([, entry]) => entry.okFromTheDescription === 0)) verdict = 'Only the recorded requests reached the tables; no read built from the description did.';
  else verdict = 'Reads from the recorded requests and from the description both reached the tables.';
  return { lines, verdict };
}

/** What the scan guard passed and refused, from its log lines (JSON, one a line). */
export function guardSummary(lines) {
  const entries = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const hosts = (filter) => [...new Set(entries.filter(filter).map((entry) => entry.target))];
  return {
    outside: hosts((entry) => entry.verdict === 'allowed' && !entry.local),
    local: hosts((entry) => entry.verdict === 'allowed' && entry.local),
    localTunnels: entries.filter((entry) => entry.verdict === 'allowed' && entry.local).length,
    refused: hosts((entry) => entry.verdict === 'refused'),
    failed: hosts((entry) => entry.verdict === 'failed'),
  };
}
