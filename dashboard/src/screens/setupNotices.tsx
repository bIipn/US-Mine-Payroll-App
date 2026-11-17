import { fmtDateTime } from '@app/util/format';

import { useCompany } from '../lib/company';
import type { WrittenOver } from '../lib/history';
import { PHONES_DO_NOT_RECEIVE } from '../lib/setup';
import { useHidden } from '../lib/versions';
import { Button, Notice } from '../ui/kit';

const listed = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * At the head of each page that saves a record: phones do not receive what is
 * saved here, what that means on this page, and what to do about it today.
 */
export function PhonesNotice({ lines }: { lines: readonly string[] }) {
  const [first, ...rest] = lines;
  return (
    <Notice tone="warn" title={PHONES_DO_NOT_RECEIVE}>
      <p>{first}</p>
      {rest.length ? (
        <ul className="notice-list">
          {rest.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </Notice>
  );
}

/**
 * A phone's copy of a record went over what was saved here, and put some of it
 * back to what the phone had. Said where the record is changed, with what was
 * put back, until it is set right or the notice is put away for now.
 */
export function WrittenOverNotice({ found, id, what, then }: {
  found: WrittenOver | null;
  /** The record, as `kind:id`: a notice put away is put away for this version of it. */
  id: string;
  /** What was replaced, in a sentence: "the settings saved here", "this sheet as it was saved here". */
  what: string;
  /** What follows from it, and what to do. */
  then: string;
}) {
  const { roster } = useCompany();
  const [away, putAway] = useHidden(`${id}:${found?.by.version ?? 0}`);
  if (!found || found.how !== 'replaced' || away) return null;
  const sender = found.by.by ? roster.find((r) => r.user_id === found.by.by) : undefined;
  const from = sender ? `, signed in as ${sender.first_name} ${sender.last_name},` : '';
  const at = Date.parse(found.by.at);
  return (
    <Notice tone="warn" title="A phone’s copy replaced what was saved here">
      <p>
        {Number.isFinite(at) ? `On ${fmtDateTime(at)} a` : 'A'} supervisor’s phone{from} sent its own copy, made from an older version than {what}. That set these back to what the phone had: {listed(found.fields)}. {then}
      </p>
      <div className="row" style={{ marginTop: '0.4rem' }}>
        <Button kind="quiet" className="btn-flush" onClick={putAway}>Hide this for now</Button>
      </div>
    </Notice>
  );
}
