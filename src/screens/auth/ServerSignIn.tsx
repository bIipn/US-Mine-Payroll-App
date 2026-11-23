import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Building2, Eye, EyeOff, LogIn } from '../../components/icons';
import { Button, Divider, Field, IconButton, Notice, Panel, Row, Sheet, Txt } from '../../components/ui';
import { otherCompany } from '../../domain/server';
import { checkEmail, checkPassword, roleWords, type ServerCompany } from '../../domain/serverAnswers';
import { server } from '../../services/connection';
import { haptic } from '../../services/haptics';
import { useStore } from '../../store/useStore';
import { color, space, TAP } from '../../theme/theme';

/**
 * What the company sign-in screen and Company account share, so neither keeps a copy: the line the
 * phone shows while it waits on the company's server, signing in with an email and a password, and
 * connecting the phone to one of the account's companies. Only in a build that names a server: both
 * screens that import this load behind the same folded condition as the server code (connection.ts).
 */

/** A spinner, and what the phone is waiting for. */
export function Waiting({ text, testID }: { text: string; testID?: string }) {
  return (
    <View style={styles.waiting} testID={testID}>
      <ActivityIndicator color={color.ink} />
      <Txt v="small" c={color.silica}>{text}</Txt>
    </View>
  );
}

/**
 * Signing in to the company server with an email and a password, as supervisors do and any account
 * that already signs in with email. Forgot password? sends the link to set a new password, which opens
 * the office dashboard in the browser. `email` fills in the address to start with.
 */
export function EmailSignIn({ email = '' }: { email?: string }) {
  const [address, setAddress] = useState(email);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'submit' | 'reset' | null>(null);
  if (!server) return null;
  const link = server;

  const submit = async () => {
    if (busy) return;
    const problem = checkEmail(address) ?? checkPassword(password, false);
    if (problem) {
      haptic.error();
      setError(problem);
      return;
    }
    setBusy('submit');
    setError(null);
    const result = await link.signIn(address, password);
    setBusy(null);
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    setPassword('');
  };

  const forgot = async () => {
    if (busy) return;
    if (checkEmail(address)) {
      haptic.error();
      setError('Enter your email above, then tap Forgot password.');
      return;
    }
    setBusy('reset');
    setError(null);
    const result = await link.resetPassword(address);
    setBusy(null);
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    setResetSentTo(address.trim().toLowerCase());
  };

  return (
    <View style={{ gap: space.lg }}>
      {resetSentTo ? (
        <View testID="server-reset-sent">
          <Notice
            tone="info"
            title="Check your email for the link"
            body={`We sent a link to ${resetSentTo} to set a new password. Set it in the browser, then sign in here with it.`}
          />
        </View>
      ) : null}
      <Field
        testID="server-email"
        label="Email"
        value={address}
        onChangeText={(text) => {
          setAddress(text);
          setError(null);
        }}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
      />
      <Field
        testID="server-password"
        label="Password"
        value={password}
        onChangeText={(text) => {
          setPassword(text);
          setError(null);
        }}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoComplete="current-password"
        onSubmitEditing={() => void submit()}
        right={<IconButton icon={show ? EyeOff : Eye} label={show ? 'Hide password' : 'Show password'} onPress={() => setShow((v) => !v)} tint={color.silica} />}
      />
      {error ? (
        <Txt v="smallStrong" c={color.red} testID="server-error" accessibilityLiveRegion="polite">{error}</Txt>
      ) : null}
      <Button testID="server-submit" label="Sign in" icon={LogIn} loading={busy === 'submit'} onPress={() => void submit()} />
      <Button testID="server-forgot" label="Forgot password?" kind="quiet" size="md" loading={busy === 'reset'} onPress={() => void forgot()} style={styles.tall} />
    </View>
  );
}

/**
 * Connecting this phone to one of the signed-in account's companies, so it sends its records there.
 * A company with another name than the one the phone is set up for is asked about first, since the
 * phone's roster, area sheets and company settings would go there too; one the phone cannot send to
 * (it sent its records to another company) is turned back by the store, and `error` says why. `ask`
 * is the question, for the screen to put on show.
 */
export function useConnectCompany(account: { id: string; email: string }) {
  const held = useStore((s) => s.settings.company.name);
  const [sure, setSure] = useState<ServerCompany | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = (company: ServerCompany, confirmed = false): boolean => {
    if (!confirmed && otherCompany(held, company.name)) {
      setSure(company);
      return false;
    }
    setSure(null);
    const { connectCompany, showToast } = useStore.getState();
    const result = connectCompany(company, account);
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return false;
    }
    setError(null);
    haptic.success();
    showToast(`Connected to ${company.name}. This phone sends its records there.`);
    return true;
  };
  const ask = (
    <Sheet testID="server-other-company" visible={sure != null} onClose={() => setSure(null)} title={sure ? `Send to ${sure.name}?` : undefined}>
      <Txt v="body" c={color.inkSoft}>
        This phone is set up for {held}. Its roster, area sheets and company settings go to {sure?.name} as well as everything people sign on it.
      </Txt>
      <Button testID="server-other-company-yes" label={`Send to ${sure?.name ?? ''}`} onPress={() => sure && connect(sure, true)} />
      <Button testID="server-other-company-no" label="Cancel" kind="outline" onPress={() => setSure(null)} />
    </Sheet>
  );
  return { connect, error, ask };
}

/** The account's companies, each a row that connects this phone to it, and why the last one could not. */
export function CompanyChoice({ companies, error, onPick }: { companies: readonly ServerCompany[]; error: string | null; onPick: (company: ServerCompany) => void }) {
  return (
    <Panel title="Your companies" flush>
      {error ? (
        <View style={styles.panelNotice} testID="server-connect-error">
          <Notice tone="bo" title="This phone cannot connect there" body={error} />
        </View>
      ) : null}
      {companies.map((company, i) => (
        <View key={company.id}>
          {i || error ? <Divider inset={space.lg} /> : null}
          <Row
            testID={`server-company-${company.id}`}
            left={<Building2 color={color.ink} size={24} />}
            title={`Connect to ${company.name}`}
            titleLines={3}
            sub={`${roleWords(company.role)} on its roster`}
            chevron
            onPress={() => onPick(company)}
          />
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  waiting: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl },
  panelNotice: { padding: space.lg },
  // A quiet button is a full tap target for a gloved thumb.
  tall: { minHeight: TAP },
});
