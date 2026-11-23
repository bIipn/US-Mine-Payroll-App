import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { CircleCheck, LogIn, RotateCcw, UserPlus } from '../../components/icons';
import { Button, Field, Notice, Segmented, Txt } from '../../components/ui';
import { stateName } from '../../domain/company';
import { PASSCODE_MAX, passcodeProblem } from '../../domain/passcode';
import { cleanText } from '../../domain/roster';
import { checkJoinCode, checkJoinName, crewWords, normalJoinCode, spacedJoinCode, type CrewAnswer, type CrewFields } from '../../domain/serverAnswers';
import { server } from '../../services/connection';
import { haptic } from '../../services/haptics';
import { color, radius, space, TAP } from '../../theme/theme';

/** A sign-in crew-auth answered: the session to keep, the company and whether a supervisor has yet to let the person in. */
export type SignedIn = Extract<CrewAnswer, { kind: 'signed_in' }>;
/** The company code and the name a sign-in was made with, as they were sent. */
export interface CrewTyped {
  code: string;
  firstName: string;
  lastName: string;
}
type Words = ReturnType<typeof crewWords>;
type Mode = 'sign_up' | 'sign_in' | 'reset';
type Sent = 'sign_up' | 'sign_in' | 'reset';

/** A supervisor's reset code: 6 digits. */
const RESET_CODE = /^[0-9]{6}$/;
const NOT_THE_SAME: Words = { title: 'The two passcodes are not the same', body: 'Type the same passcode in both boxes.', tone: 'warn' };
/** A passcode box: the number pad, hidden as it is typed, and nothing a keyboard or password manager fills in. */
const PASSCODE_BOX = { keyboardType: 'number-pad', secureTextEntry: true, autoComplete: 'off', autoCorrect: false, maxLength: PASSCODE_MAX } as const;
/** Answers to ask again after, as they come from the network or the server rather than from what was typed. */
const ASK_AGAIN: readonly CrewAnswer['kind'][] = ['busy', 'unreachable', 'server'];

/** The company a code is for, as the person sees it: "Test Pit A · Nevada". */
const companyLine = ({ name, state }: { name: string; state: string }) => (state ? `${name} · ${stateName(state) || state}` : name);

/**
 * Crew get in with the company's code, their name and a passcode, and never an email. The code is
 * looked up as it is typed, and the company's name shown, so a wrong one is caught first; only a
 * whole code is asked about, as every request counts against the server's limit. Then Sign up (the
 * passcode twice), Sign in, or Forgot your passcode? (a supervisor's reset code, and a new passcode
 * twice). What can be checked on the phone is checked before anything is sent, and what crew-auth
 * answers is said in its own words (crewWords). A sign-in hands its session to `onSignedIn`, which
 * keeps it, and answers what went wrong if anything did; `afterReset` asks it to sign the account's
 * other sessions out, as for the sign-in made with a passcode just set by a reset.
 */
export function CrewSignIn({ onSignedIn }: { onSignedIn: (answer: SignedIn, typed: CrewTyped, afterReset: boolean) => Promise<string | null> }) {
  const [code, setCode] = useState('');
  // What the code typed last answered, and for which asking of it: Try again asks once more.
  const [lookup, setLookup] = useState<{ code: string; asked: number; answer: CrewAnswer } | null>(null);
  const [asked, setAsked] = useState(0);
  const [mode, setMode] = useState<Mode>('sign_up');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  // The passcode, or on Forgot your passcode? the new one: a reset that sets it signs in with it next.
  const [passcode, setPasscode] = useState('');
  const [again, setAgain] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [said, setSaid] = useState<Words | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // The passcode was just set with a reset code, but no session came back: the sign-in made with it next
  // signs the account's other sessions out, so a lost or old phone stops working.
  const afterReset = useRef(false);

  const typedCode = normalJoinCode(code);
  const codeProblem = checkJoinCode(code);
  useEffect(() => {
    if (!server || codeProblem) return undefined;
    let live = true;
    void server.crewAuth('lookup', { code: typedCode }).then((answer) => {
      if (live) setLookup({ code: typedCode, asked, answer });
    });
    return () => {
      live = false;
    };
  }, [typedCode, codeProblem, asked]);

  if (!server) return null;
  const link = server;
  const looked = !codeProblem && lookup?.code === typedCode && lookup.asked === asked ? lookup.answer : null;
  const company = looked?.kind === 'company' ? looked : null;
  const codeWords = looked && !company ? crewWords(looked, Date.now()) : null;

  /** What was typed changed: what the last answer said no longer stands. */
  const edited = (set: (text: string) => void) => (text: string) => {
    set(text);
    setSaid(null);
  };
  const toMode = (next: Mode) => {
    // A reset's new passcode is never the old one carried over, nor the old one the new.
    if (next === 'reset' || mode === 'reset') {
      setPasscode('');
      setAgain('');
      setResetCode('');
    }
    setMode(next);
    setSaid(null);
  };
  const refuse = (words: Words) => {
    haptic.error();
    setSaid(words);
  };

  const send = async <A extends Sent>(action: A, body: CrewFields[A], typed: CrewTyped) => {
    busyRef.current = true;
    setBusy(true);
    setSaid(null);
    const answer = await link.crewAuth(action, body);
    if (answer.kind === 'signed_in') {
      const trouble = await onSignedIn(answer, typed, action === 'sign_in' && afterReset.current);
      busyRef.current = false;
      setBusy(false);
      if (trouble) return refuse({ title: 'Could not sign in on this phone', body: trouble, tone: 'warn' });
      afterReset.current = false;
      haptic.success();
      return;
    }
    busyRef.current = false;
    setBusy(false);
    if (answer.kind === 'already_signed_up') {
      // Most likely this same sign-up again: a second tap, or one sent again after its answer was lost.
      // Sign in is offered with the name and passcode already typed, in one tap.
      setMode('sign_in');
      setAgain('');
    } else if (answer.kind === 'passcode_changed') {
      // The new passcode is set, but no session came back: Sign in, with it, in one tap.
      afterReset.current = true;
      setMode('sign_in');
      setAgain('');
      setResetCode('');
    }
    const words = crewWords(answer, Date.now());
    if (words.tone === 'ok') haptic.success();
    else if (words.tone === 'info') haptic.warning();
    else haptic.error();
    setSaid(words);
  };

  const submit = () => {
    if (!company || busyRef.current) return;
    const now = Date.now();
    const name = checkJoinName(first, last);
    if (name) return refuse({ title: name, tone: 'warn' });
    const typed: CrewTyped = { code: typedCode, firstName: cleanText(first), lastName: cleanText(last) };
    const who = { code: typed.code, first_name: typed.firstName, last_name: typed.lastName };
    const problem = passcodeProblem(passcode);
    if (mode === 'sign_in') {
      // A passcode that is not one at all is not sent, so it cannot count as a wrong try.
      if (problem && problem !== 'easy') return refuse(crewWords({ kind: 'easy_passcode', problem }, now));
      return void send('sign_in', { ...who, passcode }, typed);
    }
    if (mode === 'reset' && !RESET_CODE.test(resetCode)) return refuse({ title: 'Enter the 6-digit reset code your supervisor gave you', tone: 'warn' });
    if (problem) return refuse(crewWords({ kind: 'easy_passcode', problem }, now));
    if (again !== passcode) return refuse(NOT_THE_SAME);
    if (mode === 'reset') return void send('reset', { ...who, reset_code: resetCode, new_passcode: passcode }, typed);
    return void send('sign_up', { ...who, passcode }, typed);
  };

  return (
    <View style={styles.form}>
      <Field
        testID="crew-code"
        label="Company code"
        value={code}
        // Read out the way it is easiest to check: ABCD 2345.
        onChangeText={(text) => {
          setCode(checkJoinCode(text) ? text : spacedJoinCode(text));
          setSaid(null);
        }}
        placeholder="ABCD 2345"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        maxLength={16}
        hint="8 letters and numbers. Your supervisor has it."
        error={typedCode.length >= 8 ? codeProblem : null}
      />
      {codeProblem ? null : !looked ? (
        <View style={styles.looking} testID="crew-looking">
          <ActivityIndicator color={color.ink} />
          <Txt v="small" c={color.silica}>Looking up the code…</Txt>
        </View>
      ) : company ? (
        <View style={styles.company} testID="crew-company">
          <CircleCheck color={color.green} size={26} strokeWidth={2.5} />
          <Txt v="lead" style={styles.companyName}>{companyLine(company)}</Txt>
        </View>
      ) : codeWords ? (
        <View style={styles.gap} testID="crew-code-answer">
          <Notice tone={codeWords.tone} title={codeWords.title} body={codeWords.body} />
          {looked && ASK_AGAIN.includes(looked.kind) ? (
            <Button testID="crew-code-retry" label="Try again" icon={RotateCcw} kind="outline" size="md" onPress={() => setAsked((n) => n + 1)} style={styles.tall} />
          ) : null}
        </View>
      ) : null}

      {company ? (
        <>
          {mode === 'reset' ? (
            <View style={styles.gapSmall}>
              <Txt v="h3">Set a new passcode</Txt>
              <Txt v="small" c={color.inkSoft}>Type the reset code a supervisor gave you, then a new passcode.</Txt>
            </View>
          ) : (
            <Segmented
              testID="crew-mode"
              value={mode}
              onChange={toMode}
              options={[
                { value: 'sign_up', label: 'Sign up' },
                { value: 'sign_in', label: 'Sign in' },
              ]}
            />
          )}

          <View style={styles.gapSmall}>
            <View style={styles.names}>
              <View style={styles.name}>
                <Field testID="crew-first" label="First name" value={first} onChangeText={edited(setFirst)} autoCapitalize="words" autoComplete="given-name" autoCorrect={false} />
              </View>
              <View style={styles.name}>
                <Field testID="crew-last" label="Last name" value={last} onChangeText={edited(setLast)} autoCapitalize="words" autoComplete="family-name" autoCorrect={false} />
              </View>
            </View>
            <Txt v="small" c={color.silica}>Your name the way it is on the company’s roster.</Txt>
          </View>

          {mode === 'reset' ? (
            <>
              <Field
                testID="crew-reset-code"
                label="Reset code"
                value={resetCode}
                onChangeText={edited(setResetCode)}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                autoCorrect={false}
                maxLength={6}
                hint="6 digits, from a supervisor."
              />
              <Field testID="crew-new-passcode" label="New passcode" value={passcode} onChangeText={edited(setPasscode)} hint="6 or more digits, and not an easy pattern like 123456." {...PASSCODE_BOX} />
              <Field testID="crew-new-passcode-again" label="New passcode again" value={again} onChangeText={edited(setAgain)} {...PASSCODE_BOX} />
            </>
          ) : (
            <>
              <Field
                testID="crew-passcode"
                label="Passcode"
                value={passcode}
                onChangeText={edited(setPasscode)}
                hint={mode === 'sign_up' ? '6 or more digits, and not an easy pattern like 123456.' : undefined}
                onSubmitEditing={mode === 'sign_in' ? submit : undefined}
                {...PASSCODE_BOX}
              />
              {mode === 'sign_up' ? <Field testID="crew-passcode-again" label="Passcode again" value={again} onChangeText={edited(setAgain)} {...PASSCODE_BOX} /> : null}
            </>
          )}

          {said ? (
            <View testID="crew-answer" accessibilityLiveRegion="polite">
              <Notice tone={said.tone} title={said.title} body={said.body} />
            </View>
          ) : null}

          <Button
            testID="crew-submit"
            label={mode === 'sign_up' ? 'Sign up' : mode === 'sign_in' ? 'Sign in' : 'Set new passcode'}
            icon={mode === 'sign_up' ? UserPlus : LogIn}
            loading={busy}
            onPress={submit}
          />
          {mode === 'reset' ? (
            <Button testID="crew-back" label="Back to sign in" kind="quiet" size="md" onPress={() => toMode('sign_in')} style={styles.tall} />
          ) : (
            <Button testID="crew-forgot" label="Forgot your passcode?" kind="quiet" size="md" onPress={() => toMode('reset')} style={styles.tall} />
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.lg },
  gap: { gap: space.sm },
  gapSmall: { gap: space.xs },
  looking: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 },
  company: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.greenTint,
  },
  companyName: { flex: 1 },
  names: { flexDirection: 'row', gap: space.md },
  name: { flex: 1 },
  // A quiet button is a full tap target for a gloved thumb.
  tall: { minHeight: TAP },
});
