import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { standard } from '@app/domain/standards';

import { onLink } from '../lib/router';

/** The few controls every screen is built from. */

type Kind = 'main' | 'ink' | 'line' | 'danger' | 'quiet' | 'ondark';

export function Button({ kind = 'line', small, block, busy, children, className, onClick, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  kind?: Kind;
  small?: boolean;
  block?: boolean;
  /** Working on it: the button stays put and says so. */
  busy?: boolean;
}) {
  const cls = ['btn', `btn-${kind}`, small && 'btn-small', block && 'btn-block', className].filter(Boolean).join(' ');
  // A busy button is not `disabled`: that would drop the keyboard focus to the top of the page. It ignores
  // the press instead, a form's Enter included (which presses the form's button).
  return (
    <button
      type="button"
      className={cls}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      {...rest}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}

export function LinkButton({ href, kind = 'line', small, children }: { href: string; kind?: Kind; small?: boolean; children: ReactNode }) {
  return (
    <a href={href} onClick={onLink} className={['btn', `btn-${kind}`, small && 'btn-small'].filter(Boolean).join(' ')}>
      {children}
    </a>
  );
}

export function A({ href, children, className, current }: { href: string; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a href={href} onClick={onLink} className={className} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}

export function TextField({ label, hint, error, invalid, describedBy, value, onChange, type = 'text', autoComplete, required, inputMode, maxLength, placeholder, className, list, autoFocus, inputRef }: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** At fault, with the reason said once for several fields: `describedBy` is the id of where. */
  invalid?: boolean;
  describedBy?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  inputMode?: 'text' | 'email' | 'numeric' | 'decimal';
  maxLength?: number;
  placeholder?: string;
  className?: string;
  list?: string;
  autoFocus?: boolean;
  /** For a form to move to the field when it is the one at fault. */
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={inputRef}
        className={['input', className].filter(Boolean).join(' ')}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        list={list}
        autoFocus={autoFocus}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={[hintId, errorId, describedBy].filter(Boolean).join(' ') || undefined}
      />
      {hint ? <p className="field-hint" id={hintId}>{hint}</p> : null}
      {error ? <p className="field-error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

export function AreaField({ label, hint, value, onChange, rows = 8 }: { label: string; hint?: ReactNode; value: string; onChange: (value: string) => void; rows?: number }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <textarea id={id} className="textarea" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} spellCheck={false} />
      {hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

export function SelectField<T extends string>({ label, hint, error, value, onChange, options, className, selectRef }: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  /** For a form to move to the field when it is the one at fault. */
  selectRef?: Ref<HTMLSelectElement>;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <select
        id={id}
        ref={selectRef}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint ? <p className="field-hint" id={hintId}>{hint}</p> : null}
      {error ? <p className="field-error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

export function Check({ label, hint, checked, onChange, disabled }: { label: ReactNode; /** Said under the switch, and read out with it. */ hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId();
  const box = (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <span>{label}</span>
    </label>
  );
  if (!hint) return box;
  return (
    <div className="check-set">
      {box}
      <p className="field-hint" id={`${id}-hint`}>{hint}</p>
    </div>
  );
}

/**
 * Tabs over one panel: the arrow keys, Home and End move between them, and the
 * row is a single stop for the Tab key. The panel takes `tabPanelProps(panelId, value)`.
 */
export function Tabs<T extends string>({ label, value, onChange, options, panelId }: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  panelId: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (to: number) => {
    const i = (to + options.length) % options.length;
    onChange(options[i].value);
    refs.current[i]?.focus();
  };
  const keys = (event: KeyboardEvent, i: number) => {
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: options.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    move(to);
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${panelId}-tab-${o.value}`}
          aria-selected={o.value === value}
          aria-controls={panelId}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => keys(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const tabPanelProps = (panelId: string, value: string) => ({ id: panelId, role: 'tabpanel', 'aria-labelledby': `${panelId}-tab-${value}` }) as const;

/**
 * One choice of a few, drawn as a bar of buttons. It is a set of radio buttons
 * underneath, so arrow keys move the choice. The label is read out, and shown
 * above the bar when `showLabel` is set.
 */
export function Seg<T extends string>({ label, value, onChange, options, showLabel }: {
  label: string;
  /** Undefined until one is chosen: a question nobody has answered yet. */
  value: T | undefined;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  showLabel?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="seg-set">
      <legend className={showLabel ? 'field-label' : 'sr-only'}>{label}</legend>
      <div className="seg">
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type Tone = 'ok' | 'info' | 'warn' | 'bo' | 'neutral';

export function Notice({ tone = 'neutral', title, children, live, alert }: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  live?: boolean;
  /** Said at once whatever its tone: something was not done, and the person should know now. */
  alert?: boolean;
}) {
  return (
    <div className={`notice notice-${tone}`} role={live ? (alert || tone === 'bo' ? 'alert' : 'status') : undefined}>
      {title ? <p className="notice-title">{title}</p> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

/**
 * Words for a screen reader that are already on the page when it opens, such
 * as what the page before left to be said. A region that arrives with its
 * words in it is not read out; this one is there first and takes them a moment
 * after, once the page's heading has been read.
 */
export function Announce({ text }: { text?: string | null }) {
  const [said, setSaid] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSaid(text ?? ''), 400);
    return () => window.clearTimeout(timer);
  }, [text]);
  return <div className="sr-only" role="status">{said}</div>;
}

export function Tag({ tone = 'neutral', solid, children }: { tone?: Tone | 'ink'; solid?: boolean; children: ReactNode }) {
  return <span className={`tag tag-${tone}${solid && tone === 'bo' ? '-solid' : ''}`}>{children}</span>;
}

export function Plate({ unit, large }: { unit: string; large?: boolean }) {
  return <span className={large ? 'plate plate-lg' : 'plate'}>{unit}</span>;
}

/** A button that asks once more before it does something that cannot be taken back. */
export function Confirm({ label, question, name, yes, no = 'Keep it as it is', kind = 'line', onYes, before, small, roomy }: {
  label: string;
  question: string;
  /** A short name for the question, read out before it: "Take unit L-2 out of the fleet". Without one, the button's own words. */
  name?: string;
  yes: string;
  /** The answer that changes nothing. */
  no?: string;
  kind?: Kind;
  small?: boolean;
  /** The two answers at full height, 44 px, for a page worked on a phone as well. */
  roomy?: boolean;
  onYes: () => unknown;
  /** Run before the question is put, to bring what it says up to date. Answering false puts no question. */
  before?: () => Promise<boolean | void>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  // The question shut, with either answer: the focus goes back to the button that put it.
  useEffect(() => {
    if (was.current && !asking) trigger.current?.focus();
    was.current = asking;
  }, [asking]);
  if (!asking) {
    return (
      <Button
        ref={trigger}
        kind={kind}
        small={small}
        busy={looking}
        onClick={async () => {
          if (!before) return setAsking(true);
          setLooking(true);
          try {
            if ((await before()) !== false) setAsking(true);
          } finally {
            setLooking(false);
          }
        }}
      >
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-confirm" role="group" aria-label={name ?? label} aria-describedby={id}>
      <span id={id}>{question}</span>
      <Button
        kind={kind === 'danger' ? 'danger' : 'ink'}
        small={!roomy}
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onYes();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {yes}
      </Button>
      {/* The answer that changes nothing has the focus, so a second press of Enter cannot do the one-way thing. */}
      <Button kind="quiet" small={!roomy} autoFocus onClick={() => setAsking(false)}>{no}</Button>
    </span>
  );
}

/** How long a step of loading may sit still before the page says it is still trying. */
const SLOW_MS = 3000;

export function Loading({ children }: { children: ReactNode }) {
  // A step that has not moved on for a while is most often a connection the browser is still retrying.
  const [slow, setSlow] = useState(false);
  const step = typeof children === 'string' ? children : '';
  useEffect(() => {
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [step]);
  return (
    <div className="loading" role="status">
      <div className="stack" style={{ justifyItems: 'center', textAlign: 'center' }}>
        <p>{children}</p>
        <div className="bar" aria-hidden="true"><span /></div>
        {slow ? <p className="small">Still trying to reach the server. If this computer has no connection, it keeps trying until it does.</p> : null}
      </div>
    </div>
  );
}

/** A number of things, said plainly: "1 request", "3 requests". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * A list that reads like the paper: ruled rows on white. When its columns do not
 * fit the width it has, on a phone or in a narrow window, each row is drawn as a
 * card instead, with the column heading beside each figure, so no column is ever
 * cut off out of sight. Whether they fit is measured, not guessed from the window.
 */
export function Ledger({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLTableElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Lay the table out as a table, and stack it when that is wider than its box.
  const fit = () => {
    const table = ref.current;
    const wrap = wrapRef.current;
    if (!table || !wrap) return;
    table.classList.remove('is-stacked');
    table.classList.toggle('is-stacked', table.offsetWidth > wrap.clientWidth + 1);
  };

  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const heads: (string | null)[] = [];
    table.querySelectorAll<HTMLTableCellElement>('thead tr:first-child th').forEach((th) => {
      const text = th.hasAttribute('data-nolabel') ? null : (th.textContent ?? '').trim() || null;
      for (let i = 0; i < (th.colSpan || 1); i++) heads.push(text);
    });
    table.querySelectorAll<HTMLTableRowElement>('tbody tr, tfoot tr').forEach((tr) => {
      let col = 0;
      for (const cell of Array.from(tr.cells)) {
        const label = heads[col];
        // A cell that spans columns is not one column's figure: it takes the whole row when the rows are cards.
        if (label && cell.tagName === 'TD' && !cell.classList.contains('ledger-empty') && (cell.colSpan || 1) === 1) cell.setAttribute('data-label', label);
        else cell.removeAttribute('data-label');
        col += cell.colSpan || 1;
      }
    });
    fit();
  });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    let width = wrap.clientWidth;
    let frame = 0;
    // Only a change of width can change the fit; the height changes when the table stacks.
    const observer = new ResizeObserver(() => {
      if (wrap.clientWidth === width) return;
      width = wrap.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(wrap);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="ledger-wrap" style={style} ref={wrapRef}>
      <table className="ledger" ref={ref}>{children}</table>
    </div>
  );
}

/**
 * The standards behind a line, each kept on one line of its own ("30 CFR § 56.4102"),
 * or nothing when none is cited. Only standards the app has checked are ever named.
 */
export function Cites({ keys }: { keys: (string | undefined)[] }) {
  const cites = keys.map((k) => standard(k)?.cite).filter((c): c is string => !!c);
  if (cites.length === 0) return null;
  return (
    <>
      {cites.map((cite, i) => (
        <span key={cite}>
          {i > 0 ? '; ' : null}
          <span className="cite">{cite}</span>
        </span>
      ))}
    </>
  );
}
