import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { standard } from '@app/domain/standards';

import { onLink } from '../lib/router';

/** The few controls every screen is built from. */

type Kind = 'main' | 'ink' | 'line' | 'danger' | 'quiet' | 'ondark';

export function Button({ kind = 'line', small, block, busy, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  kind?: Kind;
  small?: boolean;
  block?: boolean;
  /** Working on it: the button stays put and says so. */
  busy?: boolean;
}) {
  const cls = ['btn', `btn-${kind}`, small && 'btn-small', block && 'btn-block', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={rest.disabled || busy} aria-busy={busy || undefined} {...rest}>
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

export function TextField({ label, hint, error, value, onChange, type = 'text', autoComplete, required, inputMode, maxLength, placeholder, className, list, autoFocus, inputRef }: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
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
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
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

export function SelectField<T extends string>({ label, hint, value, onChange, options, className }: {
  label: string;
  hint?: ReactNode;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  const id = useId();
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)} aria-describedby={hint ? `${id}-hint` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

export function Check({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
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
  value: T;
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

export function Notice({ tone = 'neutral', title, children, live }: { tone?: Tone; title?: ReactNode; children?: ReactNode; live?: boolean }) {
  return (
    <div className={`notice notice-${tone}`} role={live ? (tone === 'bo' ? 'alert' : 'status') : undefined}>
      {title ? <p className="notice-title">{title}</p> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function Tag({ tone = 'neutral', solid, children }: { tone?: Tone | 'ink'; solid?: boolean; children: ReactNode }) {
  return <span className={`tag tag-${tone}${solid && tone === 'bo' ? '-solid' : ''}`}>{children}</span>;
}

export function Plate({ unit, large }: { unit: string; large?: boolean }) {
  return <span className={large ? 'plate plate-lg' : 'plate'}>{unit}</span>;
}

/** A button that asks once more before it does something that cannot be taken back. */
export function Confirm({ label, question, yes, kind = 'line', onYes, small }: {
  label: string;
  question: string;
  yes: string;
  kind?: Kind;
  small?: boolean;
  onYes: () => unknown;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return <Button kind={kind} small={small} onClick={() => setAsking(true)}>{label}</Button>;
  }
  return (
    <span className="inline-confirm" role="group" aria-label={question}>
      <span>{question}</span>
      <Button
        kind={kind === 'danger' ? 'danger' : 'ink'}
        small
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
      <Button kind="quiet" small autoFocus onClick={() => setAsking(false)}>Keep it as it is</Button>
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
        if (label && cell.tagName === 'TD' && !cell.classList.contains('ledger-empty')) cell.setAttribute('data-label', label);
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
