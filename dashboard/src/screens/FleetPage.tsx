import { useEffect, useRef, useState, type FormEvent } from 'react';

import { changedUnit, fleetOrder, meterUnitFor, newUnit, newUnitId, readMeter, unitNumber } from '@app/domain/fleet';
import { CATEGORY_LABEL, CATEGORY_ORDER, checklistFor } from '@app/domain/templates';
import type { Equipment, EquipmentCategory } from '@app/domain/types';
import { fmtDate, fmtMeter } from '@app/util/format';

import { readOpenOnUnit } from '../lib/api';
import { useCompany } from '../lib/company';
import { messageOf } from '../lib/errors';
import { putBackUnits } from '../lib/history';
import { SaidNotice, saidOf, useFormFields, useFormSaver, useSaid, useSaver, type Said } from '../lib/save';
import { anythingOpen, checklistsByUnit, lastReading, ON_PHONES, openOnUnit, PHONE_PUTS_BACK, removalQuestion, sameNumbers, SAVED_HERE_ONLY, standings, type Standing } from '../lib/setup';
import { useDeletions } from '../lib/versions';
import { A, Button, Confirm, count, Ledger, Notice, Plate, SelectField, TextField } from '../ui/kit';
import { PhonesNotice } from './setupNotices';
import { PageHead } from './Shell';

const TYPES = CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }));
const READ_IN = 'A light vehicle is read by its odometer, in miles. Everything else is read in equipment hours.';

/** The standing of a unit, in the words every other page and the app use for it. */
const STANDING: Record<Standing, { label: string; tag: string }> = {
  ready: { label: 'Ready', tag: 'tag tag-ok' },
  defect: { label: 'Defect reported', tag: 'tag tag-warn' },
  red_tagged: { label: 'Red tagged', tag: 'tag tag-bo-solid' },
};

const changeButtonId = (unitId: string) => `unit-change-${unitId}`;

/**
 * The company's equipment, as the office has it: add a unit, change what it
 * is, take it out of the fleet. Each unit's status and last reading are shown
 * as the records give them and are never changed here.
 */
export function FleetPage() {
  const ctx = useCompany();
  const { data } = ctx.shaped;
  const fleet = fleetOrder(data.equipment);
  const standing = standings(data);
  const twice = sameNumbers(data.equipment);
  const back = putBackUnits(data.equipment, useDeletions('equipment'));
  const counts = { ready: 0, defect: 0, red_tagged: 0 };
  for (const s of standing.values()) counts[s] += 1;
  const lines = checklistFor('loader').items.length;

  return (
    <>
      <PageHead title="Fleet" lede="The company’s equipment as the office has it. A unit added here is saved to the company; the crew can fill in its checklist once it is on their phones." />
      <PhonesNotice lines={ON_PHONES.fleet} />
      <div className="pair">
        <AddUnit fleet={data.equipment} />
        <section className="section" aria-labelledby="fleet-now">
          <h2 className="h2" id="fleet-now">The fleet now</h2>
          <dl className="facts">
            <div><dt>Units</dt><dd>{fleet.length}</dd></div>
            <div><dt>Ready</dt><dd>{counts.ready}</dd></div>
            <div><dt>Defect reported</dt><dd>{counts.defect}</dd></div>
            <div><dt>Red tagged</dt><dd>{counts.red_tagged}</dd></div>
          </dl>
          <p className="small muted">
            The equipment checklist is the one printed card for every machine, {lines} lines, and is not edited. A unit is on the crew’s checklist once it is in the fleet on their phones; its type only picks the standards shown beside each line.
          </p>
          <p className="small muted">A unit’s status and readings come from the crew’s checklists and maintenance requests. They are shown here and not changed here.</p>
        </section>
      </div>

      {twice.size ? (
        <Notice tone="warn" title={twice.size === 1 ? 'Two units share a number' : 'Some units share a number'}>
          <p>
            {[...twice].map(([number, units]) => `${number} (${units.length === 2 ? 'twice' : `${units.length} times`})`).join(', ')}. A unit added here and the same unit added on a phone are two records, because each gets an id of its own. Keep the one the crew’s checklists are on, as the Checklists column shows, and take the other out of the fleet.
          </p>
        </Notice>
      ) : null}

      {back.length ? (
        <Notice tone="warn" title={back.length === 1 ? 'A unit taken out of the fleet is back' : 'Units taken out of the fleet are back'}>
          <p>
            {back.map((b) => `${b.unit.unit} (taken out ${fmtDate(b.takenOutAt)})`).join(', ')}. A supervisor’s phone that still had {back.length === 1 ? 'the unit' : 'them'} sent {back.length === 1 ? 'it' : 'them'} again, which puts a unit back. Take {back.length === 1 ? 'it' : 'each'} out on the supervisors’ phones, on Crew → Fleet, then here.
          </p>
        </Notice>
      ) : null}

      <FleetTable fleet={fleet} standing={standing} twice={twice} back={new Set(back.map((b) => b.unit.id))} />
    </>
  );
}

function AddUnit({ fleet }: { fleet: Equipment[] }) {
  const save = useSaver();
  const { said, tell, clear } = useSaid();
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState<EquipmentCategory>('loader');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [reading, setReading] = useState('');
  const [problem, setProblem] = useState<{ unit?: string; reading?: string }>({});
  const [busy, setBusy] = useState(false);
  const unitRef = useRef<HTMLInputElement>(null);
  const readingRef = useRef<HTMLInputElement>(null);
  // The id the unit being typed will have. It is kept until the unit is saved or its number changes, so that
  // a second press after a lost answer sends the same record again and not a second unit with the same number.
  const idFor = useRef<{ number: string; id: string } | null>(null);
  const [turnedBack, setTurnedBack] = useState(0);
  useEffect(() => {
    if (!turnedBack) return;
    if (problem.unit) unitRef.current?.focus();
    else if (problem.reading) readingRef.current?.focus();
    // Only when a press was turned back, not as a field is put right.
  }, [turnedBack]);
  const miles = meterUnitFor(category) === 'mi';

  /** A field typed in: what was said about the last press no longer holds. */
  const typed = (field?: 'unit' | 'reading') => {
    if (said) clear();
    if (field && problem[field]) setProblem((had) => ({ ...had, [field]: undefined }));
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    clear();
    const meter = readMeter(reading);
    if (meter === undefined) {
      setProblem({ reading: miles ? 'Give the odometer as a number of miles, like 61200.' : 'Give the equipment hours as a number, like 4250.5.' });
      setTurnedBack((n) => n + 1);
      return;
    }
    const number = unitNumber(unit);
    if (idFor.current?.number !== number) idFor.current = { number, id: newUnitId() };
    // The app's own rule: what makes a unit number taken, and how a new unit starts.
    const made = newUnit(fleet, { unit, category, make, model, meter }, idFor.current.id);
    if (!made.ok) {
      setProblem({ unit: made.error });
      setTurnedBack((n) => n + 1);
      return;
    }
    setProblem({});
    setBusy(true);
    try {
      const result = await save({ kind: 'equipment', id: made.unit.id, record: made.unit, what: `unit ${made.unit.unit}` });
      if (tell(result, `Unit ${made.unit.unit} is added to the company’s fleet. It is not on the crew’s phones yet.`)) {
        idFor.current = null;
        setUnit('');
        setMake('');
        setModel('');
        setReading('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={add} noValidate aria-labelledby="add-unit-title">
      <h2 className="h2" id="add-unit-title">Add a unit</h2>
      <div className="form-grid">
        <TextField
          label="Unit number"
          value={unit}
          onChange={(text) => {
            setUnit(text);
            typed('unit');
          }}
          maxLength={20}
          hint={unit.trim() && unitNumber(unit) !== unit ? `Saved as ${unitNumber(unit)}.` : 'As it is painted on the machine, like L-16.'}
          error={problem.unit}
          inputRef={unitRef}
        />
        <SelectField<EquipmentCategory>
          label="Type of equipment"
          value={category}
          onChange={(next) => {
            setCategory(next);
            typed('reading');
          }}
          options={TYPES}
        />
      </div>
      <div className="form-grid">
        <TextField label="Make" value={make} onChange={(text) => { setMake(text); typed(); }} maxLength={60} hint="Optional." />
        <TextField label="Model" value={model} onChange={(text) => { setModel(text); typed(); }} maxLength={60} hint="Optional." />
      </div>
      <TextField
        label={miles ? 'Odometer now (miles)' : 'Equipment hours now'}
        value={reading}
        onChange={(text) => {
          setReading(text);
          typed('reading');
        }}
        inputMode="decimal"
        maxLength={12}
        hint="The reading the unit starts at. Left empty, it starts at 0."
        error={problem.reading}
        inputRef={readingRef}
      />
      <div className="row">
        <Button kind="main" type="submit" busy={busy}>{busy ? 'Adding' : 'Add to the fleet'}</Button>
      </div>
      <SaidNotice said={said} />
      <p className="small muted">{SAVED_HERE_ONLY}</p>
    </form>
  );
}

function FleetTable({ fleet, standing, twice, back }: { fleet: Equipment[]; standing: Map<string, Standing>; twice: Map<string, Equipment[]>; back: Set<string> }) {
  const ctx = useCompany();
  const { data } = ctx.shaped;
  // What was last said, and the unit it is about: said at that unit's row while it is in the fleet, over the table once it is not.
  const [last, setLast] = useState<{ said: Said; unitId: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Whether the open panel holds anything not saved: its button then says what closing it does.
  const [unsaved, setUnsaved] = useState(false);
  // The unit whose Change button takes the focus next: its panel has just shut.
  const [toButton, setToButton] = useState<{ unitId: string } | null>(null);
  useEffect(() => {
    if (toButton) document.getElementById(changeButtonId(toButton.unitId))?.focus();
  }, [toButton]);
  // Loading the records again may show otherwise: what was said before it goes.
  useEffect(() => setLast(null), [ctx.loadedAt]);
  const checklists = checklistsByUnit(data.inspections);
  const here = last && fleet.some((u) => u.id === last.unitId);

  return (
    <section className="section" aria-labelledby="fleet-title">
      <div className="section-head">
        <h2 className="h2" id="fleet-title">In the fleet</h2>
        <span className="section-note">{count(fleet.length, 'unit')}, by type and unit number.</span>
      </div>
      {/* About a unit that is no longer in the table: the notice takes the focus its panel held. */}
      {last && !here ? <SaidNotice said={last.said} take /> : null}
      <Ledger>
        {fleet.length ? (
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">Equipment</th>
              <th scope="col">Status</th>
              <th scope="col" className="r">Last reading</th>
              <th scope="col" className="r">Checklists</th>
              <th scope="col" data-nolabel><span className="sr-only">Changes</span></th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {fleet.flatMap((unit) => {
            const how = standing.get(unit.id) ?? 'ready';
            const reading = lastReading(unit, data);
            const isOpen = open === unit.id;
            const shared = twice.has(unit.unit.trim().toUpperCase());
            const out = [
              <tr key={unit.id} className={how === 'red_tagged' ? 'danger-row' : undefined}>
                <th scope="row"><Plate unit={unit.unit} /></th>
                <td>
                  {`${unit.make} ${unit.model}`.trim() || <span className="muted">No make or model</span>}
                  {shared ? <> <span className="tag tag-warn">Number used twice</span></> : null}
                  {back.has(unit.id) ? <> <span className="tag tag-warn">Back from a phone</span></> : null}
                  <span className="under">{CATEGORY_LABEL[unit.category]}</span>
                </td>
                <td><span className={STANDING[how].tag}>{STANDING[how].label}</span></td>
                <td className="r">
                  <span className="num nowrap">{fmtMeter(reading.value)} {unit.meterUnit === 'mi' ? 'mi' : 'hrs'}</span>
                  <span className="under">{reading.at ? `${fmtDate(reading.at)}, ${reading.from === 'checklist' ? 'at a checklist' : 'at the end of use'}` : 'On the unit’s record'}</span>
                </td>
                <td className="r num">{checklists.get(unit.id) ?? 0}</td>
                <td className="r">
                  <Button
                    id={changeButtonId(unit.id)}
                    kind="line"
                    aria-expanded={isOpen}
                    aria-controls={`unit-${unit.id}`}
                    onClick={() => {
                      setLast(null);
                      setUnsaved(false);
                      setOpen(isOpen ? null : unit.id);
                    }}
                  >
                    {isOpen ? (unsaved ? 'Close without saving' : 'Close') : 'Change'}<span className="sr-only"> unit {unit.unit}</span>
                  </Button>
                </td>
              </tr>,
            ];
            if (isOpen) {
              out.push(
                <tr key={`${unit.id}-change`} className="row-open">
                  <td colSpan={6} id={`unit-${unit.id}`}>
                    <UnitChanges
                      unit={unit}
                      onUnsaved={setUnsaved}
                      onDone={(said) => {
                        setLast({ said, unitId: unit.id });
                        setUnsaved(false);
                        setOpen(null);
                        setToButton({ unitId: unit.id });
                      }}
                    />
                  </td>
                </tr>,
              );
            } else if (last && last.unitId === unit.id) {
              out.push(
                <tr key={`${unit.id}-said`} className="row-open">
                  <td colSpan={6}><SaidNotice said={last.said} /></td>
                </tr>,
              );
            }
            return out;
          })}
          {fleet.length === 0 ? (
            <tr><td colSpan={6} className="ledger-empty">No units yet. The units the crew’s phones have arrive here as they send their records; a unit added above is saved to the company.</td></tr>
          ) : null}
        </tbody>
      </Ledger>
    </section>
  );
}

/** What can be changed about one unit: its type, make and model, and whether it is in the fleet at all. */
function UnitChanges({ unit, onDone, onUnsaved }: { unit: Equipment; /** Saved, or taken out: the panel shuts and the table says so. */ onDone: (said: Said) => void; onUnsaved: (unsaved: boolean) => void }) {
  const ctx = useCompany();
  const { data } = ctx.shaped;
  // From the version this panel opened on: a change a phone sent since is said, not written over.
  const saver = useFormSaver('equipment', unit.id);
  // A field nobody touched follows a newer version of the unit; one that was typed in stays as typed.
  const { fields, set, dirty } = useFormFields<{ category: EquipmentCategory; make: string; model: string }>({ category: unit.category, make: unit.make, model: unit.model });
  const { category, make, model } = fields;
  saver.shows(!dirty);
  // What went wrong is said here, beside the buttons that were pressed; what went through is said by the table.
  const { said, say, clear } = useSaid();
  const [busy, setBusy] = useState(false);
  const what = `unit ${unit.unit}`;
  const open = openOnUnit(unit, data);
  useEffect(() => onUnsaved(dirty), [dirty]);

  const change = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const made = changedUnit(data.equipment, unit.id, { category, make, model });
    if (!made.ok) {
      say({ tone: 'bo', text: made.error });
      return;
    }
    clear();
    setBusy(true);
    try {
      const result = await saver.save(made.unit, what);
      if (result.ok) onDone(saidOf(result, `Unit ${unit.unit} is saved.`));
      else say(saidOf(result, ''));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Before the question is put: what is open on the unit, read again. A
   * request or a Bad Order a phone sent after the page loaded is a record of
   * its own, so reading the unit again would not show it.
   */
  const lookAgain = async () => {
    clear();
    try {
      ctx.applyRecords(await readOpenOnUnit(ctx.choice.id, unit.id));
      return true;
    } catch (e) {
      say({ tone: 'bo', text: `What is open on the unit could not be checked, so it was not taken out. ${messageOf(e)}` });
      return false;
    }
  };

  const remove = async () => {
    const result = await saver.save(null, what);
    if (result.ok) onDone(saidOf(result, `Unit ${unit.unit} is out of the fleet. Its past checklists and requests stay on record. ${PHONE_PUTS_BACK}`));
    else say(saidOf(result, ''));
  };

  return (
    <div className="row-changes">
      <form className="stack" onSubmit={change} noValidate aria-label={`Change unit ${unit.unit}`}>
        <div className="form-grid">
          <SelectField<EquipmentCategory> label="Type of equipment" value={category} onChange={(next) => set({ category: next })} options={TYPES} hint={READ_IN} />
          <TextField label="Make" value={make} onChange={(next) => set({ make: next })} maxLength={60} />
          <TextField label="Model" value={model} onChange={(next) => set({ model: next })} maxLength={60} />
        </div>
        <div className="row">
          <Button kind="ink" type="submit" busy={busy}>{busy ? 'Saving' : 'Save the changes'}</Button>
          <Confirm
            roomy
            kind="danger"
            label="Take out of the fleet"
            name={`Take unit ${unit.unit} out of the fleet`}
            question={removalQuestion(unit, open)}
            yes="Take it out of the fleet"
            before={lookAgain}
            onYes={remove}
          />
        </div>
        <SaidNotice said={said} />
      </form>
      {anythingOpen(open) ? (
        <p className="small">
          <strong>Open on this unit:</strong>{' '}
          {[
            open.redTagged ? 'a red tag' : null,
            open.requests.length ? count(open.requests.length, 'maintenance request') : null,
            open.badOrders.length ? `${count(open.badOrders.length, 'Bad Order')} not corrected` : null,
          ].filter(Boolean).join(', ')}
          . <A href="/defects">See defects and conditions</A>
          {open.requests.length ? <>, or <A href={`/requests/${encodeURIComponent(open.requests[0].id)}`}>request #{open.requests[0].number}</A></> : null}.
        </p>
      ) : null}
      <p className="small muted">The unit number, the status and the readings are not changed here. A change saved here is the office’s: phones do not receive it yet.</p>
    </div>
  );
}
