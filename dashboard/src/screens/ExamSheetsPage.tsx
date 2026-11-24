import { useEffect, useRef, useState, type FormEvent } from 'react';

import { AREA_CONDITIONS, changedSheet, makeSheet, newSheet, openFindings, sheetInUse } from '@app/domain/areaExam';
import { checklistFor } from '@app/domain/templates';
import type { AreaSheet } from '@app/domain/types';

import { useCompany } from '../lib/company';
import { writtenOver } from '../lib/history';
import { go } from '../lib/router';
import { carryWord, SAID_TITLE, SaidNotice, saidOf, useCarriedWord, useFormFields, useFormSaver, useSaid, useSaver, type FormSaveHow, type FormSaver, type SaveResult } from '../lib/save';
import { dangerFirst, lineCount, linesText, ON_PHONES, savedAs, SAVED_FOR_PHONES, sheetUse, stopQuestion, type SheetUse } from '../lib/setup';
import { useVersions } from '../lib/versions';
import { A, Announce, AreaField, Button, Check, Confirm, count, Ledger, LinkButton, Notice, TextField } from '../ui/kit';
import { DangerBand } from '../ui/danger';
import { BlankSheetPaper } from '../ui/paper';
import { usePeople } from '../ui/people';
import { PhonesNotice, WrittenOverNotice } from './setupNotices';
import { PageHead } from './Shell';

const columnsOf = (sheet: Pick<AreaSheet, 'single'>) => (sheet.single ? 'One OK/BO column' : 'Guarding, electrical, safe access');
const hrefOf = (sheet: AreaSheet) => `/sheets/sheet/${encodeURIComponent(sheet.id)}`;
const sheetName = (sheet: Pick<AreaSheet, 'title'>) => `the ${sheet.title} sheet`;
const SIGNED_KEEP = 'Exams already signed keep the lines and the columns they were made on.';

/** A sheet as it is typed into the form: its name, its lines one to a line, and its columns. A new sheet starts empty. */
const typedOf = (sheet?: AreaSheet) => ({ title: sheet?.title ?? '', rows: sheet ? linesText(sheet) : '', single: !!sheet?.single });

/** What is still open in a sheet's area: the count, with a danger said as a danger. */
function StillOpen({ use }: { use: SheetUse }) {
  if (!use.open) return <span className="zero">0</span>;
  return <>{use.open}{use.dangers ? <> <span className="tag tag-bo-solid">Danger</span></> : null}</>;
}

/**
 * The work-area sheets a pre shift exam is made on. Each area has its own
 * lines; the conditions page is the same for all of them. A supervisor adds a
 * sheet, changes one, and stops or starts using one.
 */
export function ExamSheetsPage() {
  const ctx = useCompany();
  const { areaSheets, data } = ctx.shaped;
  const save = useSaver();
  const people = usePeople();
  // What the page before left to be said (a sheet was added) is shown as the page opens, and read out once it has.
  const carried = useCarriedWord();
  const { said, tell } = useSaid();
  const withUse = areaSheets.map((sheet) => ({ sheet, use: sheetUse(sheet, data.exams) }));
  // A danger is shown as a danger wherever its area is: its sheet comes first, in use or not.
  const inUse = dangerFirst(withUse.filter((s) => s.sheet.active));
  const off = dangerFirst(withUse.filter((s) => !s.sheet.active));
  const cardLines = checklistFor('loader').items.length;

  const start = async (sheet: AreaSheet) => {
    tell(await save({ kind: 'areaSheet', id: sheet.id, record: sheetInUse(sheet, true), what: sheetName(sheet) }), `The ${sheet.title} sheet is in use again. Phones offer it the next time they are open with signal.`);
  };

  return (
    <>
      <PageHead
        title="Pre shift exam sheets"
        lede={`The sheet for each work area a pre shift exam is made on. Each area has its own lines; the ${AREA_CONDITIONS.length} conditions on the second page are the same for every area.`}
      />
      {/* A danger is shown as a danger wherever its area is, ahead of anything else. */}
      <DangerBand dangers={ctx.board.dangers} nameOf={people.name} />
      <PhonesNotice lines={ON_PHONES.sheets} />
      <Notice tone="info">
        The equipment checklist is not one of these. It is the one printed card for every machine, {cardLines} lines, and is not edited. A unit is on the crew’s checklist once it is in the fleet on their phones: see <A href="/fleet">Fleet</A>.
      </Notice>
      {carried && !said ? <Notice tone={carried.tone} title={SAID_TITLE[carried.tone]}>{carried.text}</Notice> : null}
      <Announce text={carried?.text} />
      {/* Starting a sheet again moves its row, and the button that was pressed with it: what is said takes the focus. */}
      <SaidNotice said={said} take />

      <section className="section" aria-labelledby="sheets-in-use">
        <div className="section-head">
          <h2 className="h2" id="sheets-in-use">In use</h2>
          <LinkButton href="/sheets/add" kind="main">Add an area sheet</LinkButton>
        </div>
        <Ledger>
          {inUse.length ? (
            <thead>
              <tr>
                <th scope="col" className="nowrap">Work area</th>
                <th scope="col" className="r nowrap">Lines of its own</th>
                <th scope="col" className="nowrap">Columns</th>
                <th scope="col" className="r nowrap">Exams on record</th>
                <th scope="col" className="r nowrap">Still open</th>
                <th scope="col" data-nolabel><span className="sr-only">Open the sheet</span></th>
              </tr>
            </thead>
          ) : null}
          <tbody>
            {inUse.map(({ sheet, use }) => (
              <tr key={sheet.id} className={use.dangers ? 'danger-row' : undefined}>
                <th scope="row" className="nowrap"><A className="rowlink" href={hrefOf(sheet)}>{sheet.title}</A></th>
                <td className="r num">{sheet.rows.length}</td>
                <td className="nowrap">{columnsOf(sheet)}</td>
                <td className="r num">{use.exams}</td>
                <td className="r num nowrap"><StillOpen use={use} /></td>
                <td className="r"><LinkButton href={hrefOf(sheet)}>See or change<span className="sr-only"> {sheet.title}</span></LinkButton></td>
              </tr>
            ))}
            {inUse.length === 0 ? (
              <tr><td colSpan={6} className="ledger-empty">No area sheet is in use. Add one for each work area, with its lines typed in from the paper sheet.</td></tr>
            ) : null}
          </tbody>
        </Ledger>
        <p className="small muted">Most sheets check each line for guarding, electrical and safe access. Some mark each line OK or BO once: those have one OK/BO column.</p>
      </section>

      {off.length ? (
        <section className="section" aria-labelledby="sheets-off">
          <h2 className="h2" id="sheets-off">Not in use</h2>
          <Ledger>
            <thead>
              <tr>
                <th scope="col" className="nowrap">Work area</th>
                <th scope="col" className="r nowrap">Lines of its own</th>
                <th scope="col" className="r nowrap">Exams on record</th>
                <th scope="col" className="r nowrap">Still open</th>
                <th scope="col" data-nolabel><span className="sr-only">Changes</span></th>
              </tr>
            </thead>
            <tbody>
              {off.map(({ sheet, use }) => (
                <tr key={sheet.id} className={use.dangers ? 'danger-row' : undefined}>
                  <th scope="row" className="nowrap"><A className="rowlink" href={hrefOf(sheet)}>{sheet.title}</A></th>
                  <td className="r num">{sheet.rows.length}</td>
                  <td className="r num">{use.exams}</td>
                  <td className="r num nowrap"><StillOpen use={use} /></td>
                  <td className="r"><StartButton onStart={() => start(sheet)} title={sheet.title} /></td>
                </tr>
              ))}
            </tbody>
          </Ledger>
          <p className="small muted">Stopped here. Their exams stay on record, and what is open in their areas stays open until its date fixed is recorded.</p>
        </section>
      ) : null}
    </>
  );
}

function StartButton({ onStart, title }: { onStart: () => Promise<void>; title: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      kind="line"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onStart();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Saving' : 'Start using it again'}<span className="sr-only">: {title}</span>
    </Button>
  );
}

/** One sheet, drawn as the paper it is beside the form that changes it; or, with no id, a new sheet being typed in. */
export function ExamSheetPage({ id }: { id?: string }) {
  const ctx = useCompany();
  const sheet = id === undefined ? undefined : ctx.shaped.areaSheets.find((s) => s.id === id);
  if (id !== undefined && !sheet) {
    return (
      <>
        <PageHead title="Sheet not found" crumb={<A href="/sheets">Exam sheets</A>} />
        <Notice tone="info">This area sheet is not among the records on the server. It may have been taken off. <A href="/sheets">See the sheets</A>.</Notice>
      </>
    );
  }
  return sheet ? <SheetEditor key={sheet.id} sheet={sheet} /> : <NewSheet />;
}

/** A sheet being changed saves from the version its form opened on, so a change a phone sent since is said, not written over. */
function SheetEditor({ sheet }: { sheet: AreaSheet }) {
  const saver = useFormSaver('areaSheet', sheet.id);
  return <SheetForm sheet={sheet} saveSheet={(next, how) => saver.save(next, sheetName(next), how)} shows={saver.shows} />;
}

/** A new sheet's id is only known once its name is typed; it saves from whatever the page holds under that id. */
function NewSheet() {
  const save = useSaver();
  return <SheetForm saveSheet={(next) => save({ kind: 'areaSheet', id: next.id, record: next, what: sheetName(next) })} />;
}

/** Whether a phone's copy of the sheet went over what was saved here, and what that put back. */
function SheetWrittenOver({ sheet }: { sheet: AreaSheet }) {
  const versions = useVersions('areaSheet', sheet.id);
  return (
    <WrittenOverNotice
      found={versions ? writtenOver('areaSheet', versions) : null}
      id={`areaSheet:${sheet.id}`}
      what="this sheet as it was saved here"
      then="The sheet below is what the server has now. Set it again here if the office’s was right: phones take what is saved here the next time they are open with signal, and the server no longer takes an older copy over it."
    />
  );
}

function SheetForm({ sheet, saveSheet, shows }: { sheet?: AreaSheet; saveSheet: (next: AreaSheet, how?: FormSaveHow) => Promise<SaveResult>; shows?: FormSaver['shows'] }) {
  const ctx = useCompany();
  const people = usePeople();
  const { areaSheets, data } = ctx.shaped;
  const { said, tell, clear } = useSaid();
  // Stopping and starting the sheet is said under its own button, not under the form's.
  const use = useSaid();
  // A field nobody touched follows a newer version of the sheet; one that was typed in stays as typed.
  const { fields, set, dirty: differs, restart } = useFormFields(typedOf(sheet));
  const { title, rows, single } = fields;
  shows?.(!differs);
  // Held as a new object each time, so that a second save turned back for the same reason moves the focus again.
  const [problem, setProblem] = useState<{ text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problem) titleRef.current?.focus();
  }, [problem]);

  // The sheet as typed, for the paper beside the form. A name not typed yet still draws the lines.
  const made = makeSheet(title, rows, [], single);
  const preview = made ?? { title: '', rows: makeSheet('x', rows)?.rows ?? [], ...(single ? { single: true } : null) };
  const keptAs = savedAs(title, made?.title);
  const lines = lineCount(rows);
  const dirty = !!sheet && differs;
  const inArea = sheet ? sheetUse(sheet, data.exams) : undefined;

  /** A field typed in: what was said about the last save no longer holds. */
  const typed = (part: Partial<typeof fields>) => {
    set(part);
    if (said) clear();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    clear();
    // The app's own rules: a sheet needs its area's name, and no two sheets share one.
    const next = sheet ? changedSheet(areaSheets, sheet.id, title, rows, single) : newSheet(areaSheets, title, rows, single);
    if (!next.ok) {
      setProblem({ text: next.error });
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const result = await saveSheet(next.sheet);
      if (sheet) {
        if (tell(result, `The ${next.sheet.title} sheet is saved. ${SIGNED_KEEP}`)) {
          // The name as it was saved: a heading typed as "North Plant areas:" is kept as "North Plant".
          restart(typedOf(next.sheet));
        }
      } else if (result.ok) {
        carryWord(saidOf(result, `The ${next.sheet.title} sheet is added, with ${count(next.sheet.rows.length, 'line')} of its own. Phones get it the next time they are open with signal.`));
        go('/sheets');
      } else {
        tell(result, '');
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    if (!sheet) return;
    restart(typedOf(sheet));
    setProblem(null);
    clear();
  };

  const setInUse = async (active: boolean) => {
    if (!sheet) return;
    const done = active
      ? `The ${sheet.title} sheet is in use again. Phones offer it the next time they are open with signal.`
      : `The ${sheet.title} sheet is stopped. Its exams stay on record. Phones stop offering it the next time they are open with signal.`;
    // The button is beside the sheet as the page draws it now: the change goes from that version.
    use.tell(await saveSheet(sheetInUse(sheet, active), { drawn: true }), done);
  };

  const form = (
    <form className="panel" onSubmit={submit} noValidate aria-labelledby="sheet-form-title">
      <h2 className="h2" id="sheet-form-title">{sheet ? 'Change the sheet' : 'The sheet'}</h2>
      {sheet ? null : (
        <p className="narrow-only">
          <Button kind="quiet" className="btn-flush" onClick={() => paperRef.current?.scrollIntoView({ block: 'start' })}>See the sheet as it is typed</Button>
        </p>
      )}
      <TextField
        label="Work area"
        value={title}
        onChange={(text) => {
          typed({ title: text });
          setProblem(null);
        }}
        maxLength={80}
        hint={keptAs ? `Saved as ${keptAs}.` : 'The name printed at the top of the sheet.'}
        error={problem?.text}
        inputRef={titleRef}
      />
      <AreaField
        label="Lines of the sheet"
        value={rows}
        onChange={(text) => typed({ rows: text })}
        rows={12}
        hint={`${count(lines, 'line')}. One line for each line of the paper sheet, typed the way it is printed. An area can start with none and still get the conditions page.`}
      />
      <Check
        label="One OK/BO column"
        hint="For a sheet that marks each line OK or BO once, with no guarding, electrical and safe access columns."
        checked={single}
        onChange={(on) => typed({ single: on })}
      />
      {sheet ? <p className="small muted">Changing the sheet changes only the exams made from now on. {SIGNED_KEEP}</p> : null}
      <div className="row">
        <Button kind="main" type="submit" busy={busy}>{busy ? 'Saving' : sheet ? 'Save the sheet' : 'Add the sheet'}</Button>
        {sheet && dirty ? <Button kind="quiet" onClick={reset}>Put back what is saved</Button> : null}
      </div>
      <SaidNotice said={said} />
      <p className="small muted">{SAVED_FOR_PHONES}</p>
    </form>
  );

  return (
    <>
      <PageHead
        title={sheet ? sheet.title : 'Add an area sheet'}
        crumb={<A href="/sheets">Exam sheets</A>}
        lede={
          sheet
            ? `The pre shift exam sheet for this work area${sheet.active ? '' : '. It is not in use now'}. Change it in the form.`
            : 'Type the sheet in from the paper: the name of the work area at its top, then each of its lines.'
        }
      />
      {sheet ? <DangerBand dangers={openFindings(data.exams, sheet.id).filter((f) => f.danger)} nameOf={people.name} /> : null}
      {sheet ? <SheetWrittenOver sheet={sheet} /> : <PhonesNotice lines={ON_PHONES.sheets} />}
      <div className="split">
        <div className="desk" ref={paperRef}>
          <BlankSheetPaper sheet={preview} />
          <p className="paper-note">
            The sheet as the crew fills it in{dirty || !sheet ? ', as it is typed here' : ''}. The conditions page, the same {AREA_CONDITIONS.length} lines for every area, follows it on every exam.
          </p>
        </div>
        {/* A sheet that is there is shown as the paper first at every width; a new one starts from its form. */}
        <div className={sheet ? 'stack-lg' : 'stack-lg split-first'}>
          {form}

          {sheet && inArea ? (
            <section className="section" aria-labelledby="sheet-use-title">
              <h2 className="h2" id="sheet-use-title">This sheet</h2>
              <dl className="facts">
                <div><dt>In use</dt><dd>{sheet.active ? 'Yes' : 'No'}</dd></div>
                <div><dt>Lines of its own</dt><dd>{sheet.rows.length}</dd></div>
                <div><dt>Columns</dt><dd>{columnsOf(sheet)}</dd></div>
                <div><dt>Exams on record</dt><dd>{inArea.exams}</dd></div>
                <div><dt>Conditions still open</dt><dd>{inArea.open}{inArea.dangers ? <> <span className="tag tag-bo-solid">Danger</span></> : null}</dd></div>
              </dl>
              {inArea.open ? (
                <p className="small">Open conditions in this area are on <A href="/defects">Defects and conditions</A>. Each stays open until its date fixed is recorded in the app.</p>
              ) : null}
              <div className="row">
                {sheet.active ? (
                  <Confirm
                    roomy
                    kind="danger"
                    label="Stop using this sheet"
                    name={`Stop using the ${sheet.title} sheet`}
                    question={stopQuestion(sheet, inArea)}
                    yes="Stop using it"
                    onYes={() => setInUse(false)}
                  />
                ) : (
                  <StartButton onStart={() => setInUse(true)} title={sheet.title} />
                )}
              </div>
              {/* The button that was pressed gives way to the other one: what is said takes the focus. */}
              <SaidNotice said={use.said} take />
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
