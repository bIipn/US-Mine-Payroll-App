import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { estimateGross, type RangePayroll } from '../domain/payroll';
import { haptic } from '../services/haptics';
import { useStore } from '../store/useStore';
import { color, radius, space } from '../theme/theme';
import { fmtHrs, fmtMoney, fmtRate } from '../util/format';
import { Banknote } from './icons';
import { Button, Field, Sheet, Txt } from './ui';

/**
 * What the pay period should come to before taxes, line by line the way the
 * pay stub lists it: hours x rate for straight time, overtime, double time and
 * paid leave. Uses the hourly rate the person entered for themselves.
 */
export function PayEstimate({ hours }: { hours: RangePayroll }) {
  const rate = useStore((s) => (s.session ? s.payRates[s.session.employeeId] : undefined));
  const [editing, setEditing] = useState(false);

  if (!rate) {
    return (
      <>
        <View style={styles.card}>
          <Txt v="lead">See what this check should come to</Txt>
          <Txt v="small" c={color.silica}>
            Enter your hourly rate and the app works out your gross pay for the period: straight time, overtime at 1.5 times and double time at 2 times.
          </Txt>
          <Button testID="rate-add" label="Enter my hourly rate" icon={Banknote} size="md" kind="outline" onPress={() => setEditing(true)} />
        </View>
        <RateSheet visible={editing} onClose={() => setEditing(false)} />
      </>
    );
  }

  const estimate = estimateGross(hours, rate);
  return (
    <>
      <View style={styles.card} testID="pay-estimate">
        <View style={styles.head}>
          <View style={{ flex: 1 }}>
            <Txt v="small" c={color.silica}>Estimated gross pay</Txt>
            <Txt v="h1" testID="estimate-gross">{fmtMoney(estimate.grossCents)}</Txt>
          </View>
          <Button testID="rate-edit" label="My rate" size="md" kind="quiet" onPress={() => setEditing(true)} />
        </View>
        {estimate.lines.length > 0 ? (
          <View style={styles.lines}>
            {estimate.lines.map((line) => (
              <View key={line.code} style={styles.line} testID={`estimate-${line.code}`}>
                <Txt v="strong" style={styles.code}>{line.code}</Txt>
                <Txt v="body" c={color.inkSoft} style={{ flex: 1 }}>
                  {fmtHrs(line.hours)} × {fmtRate(line.rateCents)}
                </Txt>
                <Txt v="strong" style={styles.amount}>{fmtMoney(line.amountCents)}</Txt>
              </View>
            ))}
          </View>
        ) : null}
        <Txt v="small" c={color.silica}>
          Before taxes and deductions, at {fmtMoney(rate)} an hour. Your pay stub is the official figure.
        </Txt>
      </View>
      <RateSheet visible={editing} onClose={() => setEditing(false)} />
    </>
  );
}

/** Enter, change or remove the hourly rate used for the estimate. */
export function RateSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const rate = useStore((s) => (s.session ? s.payRates[s.session.employeeId] : undefined));
  const { setMyRate, showToast } = useStore.getState();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Start from the saved rate each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setText(rate ? (rate / 100).toFixed(2) : '');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = onClose;

  const save = () => {
    const cleaned = text.replace(/[$,\s]/g, '');
    const dollars = cleaned === '' ? Number.NaN : Number(cleaned);
    const result = setMyRate(Number.isFinite(dollars) ? Math.round(dollars * 100) : Number.NaN);
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    showToast('Rate saved for your estimate');
    close();
  };

  return (
    <Sheet testID="rate-sheet" visible={visible} onClose={close} title="My hourly rate">
      <Txt v="body" c={color.inkSoft}>
        Only you see this. It stays on this phone and is used for one thing: estimating your gross pay.
      </Txt>
      <Field
        testID="rate-input"
        label="Straight-time rate, dollars an hour"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setError(null);
        }}
        keyboardType="decimal-pad"
        placeholder="24.00"
        error={error}
        hint="It is on your pay stub under Rate, on the ST line."
      />
      <Button testID="rate-save" label="Save my rate" kind="ink" onPress={save} />
      {rate ? (
        <Button
          testID="rate-remove"
          label="Remove my rate"
          kind="quiet"
          size="md"
          onPress={() => {
            setMyRate(null);
            showToast('Rate removed', 'info');
            close();
          }}
        />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.md,
    padding: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  lines: { borderTopWidth: 1, borderTopColor: color.rule },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.rule },
  code: { width: 68 },
  amount: { textAlign: 'right' },
});
