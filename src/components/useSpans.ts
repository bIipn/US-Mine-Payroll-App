import { useMemo, useState } from 'react';

import { spanOf, viewsFor, type Span, type SpanKind } from '../domain/spans';
import { useStore } from '../store/useStore';

/**
 * Which run of days a screen shows hours for: the company's pay period when it
 * has set one, the workweek, or the month. Each kind remembers the one last
 * looked at, so switching away and back returns to it.
 */
export function useSpans(at: number, first?: SpanKind) {
  const pay = useStore((s) => s.settings.company.pay);
  const weekStartsOn = useStore((s) => s.settings.workweekStartsOn);
  const options = useMemo(() => ({ pay, weekStartsOn }), [pay, weekStartsOn]);
  const views = viewsFor(pay);
  const [chosen, setChosen] = useState<SpanKind>(first && views.includes(first) ? first : views[0]);
  const [picked, setPicked] = useState<{ options: typeof options; spans: Partial<Record<SpanKind, Span>> }>({ options, spans: {} });
  // A change to the schedule or the workweek starts every kind afresh.
  const spans = picked.options === options ? picked.spans : {};
  const view = views.includes(chosen) ? chosen : views[0];
  const span = spans[view] ?? spanOf(view, at, options);
  return {
    views,
    view,
    setView: setChosen,
    span,
    setSpan: (next: Span) => setPicked({ options, spans: { ...spans, [next.kind]: next } }),
    options,
  };
}
