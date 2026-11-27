import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { CloudUpload, Eye, EyeOff, LogIn, OctagonAlert, RotateCcw, TriangleAlert, UserX } from '../../components/icons';
import { PASSCODE_BOX } from '../../components/passcodeBox';
import { Button, Field, IconButton, Notice, Page, Panel, Sheet, Txt } from '../../components/ui';
import { ACCOUNT_PAGE, DELETED_TOAST, deletionPlan, LOCAL_CONFIRM, PASSCODE_LABEL, SECRET_HINT, whoseSignIn, type Blocker, type DeletionCheckCompany } from '../../domain/accountDeletion';
import { keepsTime } from '../../domain/company';
import { unitsCheckedOut } from '../../domain/fleet';
import type { ScreenProps } from '../../navigation/types';
import { CAN_CONNECT, deleteMyServerAccount, forgetDeletedSignIn, server, useServerAccount, type ServerDeletion } from '../../services/connection';
import { haptic } from '../../services/haptics';
import { openWebPage } from '../../services/links';
import { syncNow, useSyncStatus } from '../../services/sync';
import { SAMPLE_CREW_IDS } from '../../store/seed';
import { openShiftOf, staleShiftOf, useMe, useStore } from '../../store/useStore';
import { color, space } from '../../theme/theme';
import { fmtDate, fmtTime } from '../../util/format';

/**
 * Delete my account: what goes, what stays with the company and why, and what happens to this
 * phone, before anything is deleted. The company sign-in is deleted on MineMuster's server first,
 * when it is the person's own, and then the account on the phone; if the server does not delete it,
 * nothing on the phone is touched. The server checks the sign-in's own secret first: a crew member's
 * passcode, typed on the number pad, or the password of a sign-in by email. In every build: an account
 * kept on the phone alone is deleted here too. From the company sign-in screen there may be no account
 * open on the phone (someone taken off the roster): then the company sign-in is deleted alone, and so it
 * is with `signInOnly` (an email sign-in on no company's roster), with nothing of whoever is signed in to
 * the app. The server is reached only through `src/services/connection.ts`. Once deleted the screen goes
 * back to where it was opened from, and the navigator takes it off with the signed-in view.
 */
export function DeleteAccountScreen({ navigation, route }: ScreenProps<'DeleteAccount'>) {
  const signInOnly = !!route.params?.signInOnly;
  const signedIn = useMe() ?? null;
  const me = signInOnly ? null : signedIn;
  const session = useStore((s) => s.session);
  const signedInAccount = useStore((s) => s.accounts.find((a) => a.id === s.session?.accountId)) ?? null;
  const account = signInOnly ? null : signedInAccount;
  const accounts = useStore((s) => s.accounts);
  const company = useStore((s) => s.settings.company);
  const shifts = useStore((s) => s.shifts);
  const opLogs = useStore((s) => s.opLogs);
  const equipment = useStore((s) => s.equipment);
  const rate = useStore((s) => (s.session ? s.payRates[s.session.employeeId] : undefined));
  const linked = useStore((s) => s.connectedCompany);
  const receiving = useStore((s) => s.receiving);
  const { known, account: serverAccount } = useServerAccount();
  const sync = useSyncStatus();
  const [check, setCheck] = useState<DeletionCheckCompany[] | 'checking' | 'unknown' | 'failed'>('unknown');
  const [password, setPassword] = useState('');
  const [passcode, setPasscode] = useState('');
  const [show, setShow] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [problem, setProblem] = useState<{ error: string; reason?: Extract<ServerDeletion, { ok: false }>['reason'] } | null>(null);

  const now = Date.now();
  const standing = receiving ? { role: receiving.role, name: receiving.name } : null;
  // The sign-in signed in here, with how it signs in: a crew member's passcode sign-in has no address to name.
  const signedInServer = CAN_CONNECT ? (known ? serverAccount : undefined) : null;
  const signIn = whoseSignIn({ canConnect: CAN_CONNECT, linked, standing, serverAccount: signedInServer, me, account });

  // What deleting the company sign-in means in each of its companies, asked of the server when it is theirs.
  const askFor = signIn.kind === 'theirs' && sync.online ? serverAccount?.id ?? null : null;
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!askFor || !server) return undefined;
    let live = true;
    setCheck('checking');
    void server.deletionCheck().then((result) => {
      if (live) setCheck(result.ok ? result.companies : 'failed');
    });
    return () => {
      live = false;
    };
  }, [askFor, tries]);

  // The unit they have checked out, as signing out of the phone finds it (unitsCheckedOut): one they can still end use of.
  const myUnit = me ? unitsCheckedOut(me.id, opLogs, equipment, receiving?.gone)[0]?.unit : undefined;
  // Everyone else with a shift open on this phone.
  const othersOnClock = me
    ? [...new Set(shifts.filter((s) => !s.clockOut && s.employeeId !== me.id).map((s) => s.employeeId))].filter((id) => openShiftOf(shifts, id, now)).length
    : 0;
  const plan = deletionPlan({
    now,
    me,
    account,
    sample: !!me && SAMPLE_CREW_IDS.has(me.id),
    keepsTime: keepsTime(company),
    company: company.name,
    openShift: me ? openShiftOf(shifts, me.id, now) : undefined,
    staleShift: me ? staleShiftOf(shifts, me.id, now) : undefined,
    openUnit: myUnit?.unit ?? null,
    hasRate: !signInOnly && rate != null,
    canConnect: CAN_CONNECT,
    linked,
    standing,
    serverAccount: signedInServer,
    otherAccounts: session ? accounts.filter((a) => a.id !== session.accountId).length : accounts.length,
    othersOnClock,
    caughtUp: receiving?.caughtUpAt != null,
    sync: { online: sync.online, waiting: sync.waiting, notTaken: sync.notTaken, stuck: sync.stuck, trouble: sync.trouble },
    check,
    fmtTime,
    fmtDay: fmtDate,
  });
  const appAccount = !!me && !!account;
  const blocked = plan.blockers.length > 0;
  const asksSecret = plan.needsPassword || plan.needsPasscode;
  const store = useStore.getState();

  /**
   * The phone's part, once the server's is done or there is none. `deleted` when the server deleted the
   * company sign-in, or had already: only then, or with an account deleted here, is the person told so.
   */
  const finishHere = (deleted: boolean) => {
    if (appAccount) {
      const done = store.deleteMyAccount({ clearPhone: plan.clearsPhone });
      if (!done.ok) {
        haptic.error();
        setProblem({ error: done.error });
        return;
      }
      haptic.success();
      // Said to be cleared, and not: something reached this phone, or is waiting, since the screen said so.
      store.showToast(
        plan.clearsPhone && !done.cleared ? `${DELETED_TOAST} This phone was not cleared: it holds records that have not reached the company yet.` : DELETED_TOAST,
        plan.clearsPhone && !done.cleared ? 'warn' : 'ok',
      );
      // Opened from the company sign-in screen (someone taken off the roster), the signed-out view stays:
      // back to it, rather than this screen for an account that is gone.
      if (navigation.canGoBack()) navigation.goBack();
      return;
    }
    navigation.goBack();
    if (!deleted) return;
    haptic.success();
    store.showToast(DELETED_TOAST);
  };

  const deleteIt = async () => {
    if (busyRef.current || blocked) return;
    if (plan.needsPassword && !password) {
      haptic.error();
      setProblem({ error: `Enter the password for ${signIn.kind === 'theirs' && signIn.email ? signIn.email : 'your company sign-in'}.` });
      return;
    }
    if (plan.needsPasscode && !passcode) {
      haptic.error();
      setProblem({ error: 'Enter your passcode.' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    try {
      if (plan.serverToo) {
        const result = await deleteMyServerAccount(plan.needsPasscode ? { passcode } : { password });
        setPassword('');
        setPasscode('');
        if (!result.ok) {
          haptic.error();
          setProblem({ error: result.error, reason: result.reason });
          if (result.reason === 'last_supervisor') setTries((n) => n + 1);
          return;
        }
      }
      finishHere(plan.serverToo);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const deleteRestHere = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await forgetDeletedSignIn();
      finishHere(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openDashboard = async () => {
    haptic.tap();
    if (!(await openWebPage(ACCOUNT_PAGE))) store.showToast(`This phone could not open the page. In a browser, go to ${ACCOUNT_PAGE.replace('https://', '')}.`, 'bo');
  };

  const act = (blocker: Blocker) => {
    if (blocker.action === 'clock') return <Button testID="delete-go-clock" label="Go to Clock" kind="outline" size="md" onPress={() => navigation.navigate('Main', { screen: 'Clock' })} style={styles.noticeButton} />;
    if (blocker.action === 'send' && sync.online && !sync.sending) return <Button testID="delete-send-now" label="Send now" icon={CloudUpload} kind="outline" size="md" onPress={() => void syncNow()} style={styles.noticeButton} />;
    if (blocker.action === 'dashboard') {
      // Once someone else is a supervisor, or the company is closed, the server is asked again from here.
      return (
        <View style={styles.actions}>
          <Button testID="delete-dashboard" label="Finish on the office dashboard" kind="outline" size="md" onPress={() => void openDashboard()} style={styles.noticeButton} />
          <Button testID="delete-check-again" label="Check again" kind="quiet" size="md" onPress={() => setTries((n) => n + 1)} style={styles.noticeButton} />
        </View>
      );
    }
    if (blocker.action === 'reset') return <Button testID="delete-back" label="Back to More" kind="outline" size="md" onPress={() => navigation.goBack()} style={styles.noticeButton} />;
    if (blocker.action === 'retry') {
      return <Button testID="delete-check-retry" label="Try again" icon={RotateCcw} kind="outline" size="md" onPress={() => setTries((n) => n + 1)} style={styles.noticeButton} />;
    }
    // A company sign-in alone, signed out: it is deleted from the company sign-in screen it was opened from, once signed in to again.
    if (blocker.action === 'sign_in') {
      return <Button testID="delete-sign-in" label="Sign in again" icon={LogIn} kind="outline" size="md" onPress={() => navigation.goBack()} style={styles.noticeButton} />;
    }
    return null;
  };

  return (
    <Page testID="delete-account-screen" title={plan.title} onBack={navigation.goBack}>
      <View style={{ gap: space.xl }}>
        <Txt v="lead">{plan.intro}</Txt>

        {plan.blockers.map((blocker) => (
          <View key={blocker.kind} testID={`delete-blocker-${blocker.kind}`}>
            {blocker.kind === 'checking' ? (
              <View style={styles.checking}>
                <ActivityIndicator color={color.ink} />
                <Txt v="small" c={color.silica}>{blocker.title}</Txt>
              </View>
            ) : (
              <Notice tone={blocker.kind === 'last_supervisor' || blocker.kind === 'sample' ? 'bo' : 'warn'} icon={OctagonAlert} title={blocker.title} body={blocker.body}>
                {act(blocker)}
              </Notice>
            )}
          </View>
        ))}

        {plan.warnings.map((line) => (
          <Notice key={line} tone="warn" icon={TriangleAlert} title={line} />
        ))}

        {plan.deletes.length ? (
          <Panel title="What is deleted">
            <View style={styles.lines} testID="delete-what-goes">
              {plan.deletes.map((line) => (
                <Txt key={line} v="body">{line}</Txt>
              ))}
            </View>
          </Panel>
        ) : null}

        {plan.keeps.length ? (
          <Panel title={plan.keepsTitle}>
            <View style={styles.lines} testID="delete-what-stays">
              {plan.keeps.map((line) => (
                <Txt key={line} v="body">{line}</Txt>
              ))}
              <Txt v="small" c={color.silica}>{plan.legal}</Txt>
            </View>
          </Panel>
        ) : null}

        {plan.phone.length ? (
          <Panel title="This phone">
            <View style={styles.lines} testID="delete-this-phone">
              {plan.phone.map((line) => (
                <Txt key={line} v="body">{line}</Txt>
              ))}
            </View>
          </Panel>
        ) : null}

        {problem ? (
          <View style={{ gap: space.sm }} testID="delete-problem" accessibilityLiveRegion="polite">
            <Txt v="smallStrong" c={color.red}>{problem.error}</Txt>
            {problem.reason === 'last_supervisor' ? (
              <Button testID="delete-dashboard-after" label="Finish on the office dashboard" kind="outline" size="md" onPress={() => void openDashboard()} style={styles.noticeButton} />
            ) : null}
            {problem.reason === 'already_deleted' ? (
              <Button testID="delete-rest-here" label="Delete from this phone" kind="red" size="md" loading={busy} onPress={() => void deleteRestHere()} style={styles.noticeButton} />
            ) : null}
          </View>
        ) : null}

        {!blocked ? (
          <View style={{ gap: space.md }}>
            {/* Neither box deletes from the keyboard, so deleting always takes the red button. Android's number
                pad has a Done key, tapped to put the keyboard away: it would delete the account at once, or send
                part of a passcode as a wrong try. */}
            {plan.needsPassword && plan.passwordLabel ? (
              <Field
                testID="delete-password"
                label={plan.passwordLabel}
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  setProblem(null);
                }}
                secureTextEntry={!show}
                autoCapitalize="none"
                autoComplete="current-password"
                hint={SECRET_HINT}
                right={<IconButton icon={show ? EyeOff : Eye} label={show ? 'Hide password' : 'Show password'} onPress={() => setShow((v) => !v)} tint={color.silica} />}
              />
            ) : null}
            {plan.needsPasscode ? (
              // As crew sign-in's passcode boxes are: the number pad, hidden, filled in by nothing, a passcode's length.
              <Field
                testID="delete-passcode"
                label={PASSCODE_LABEL}
                value={passcode}
                onChangeText={(text) => {
                  setPasscode(text);
                  setProblem(null);
                }}
                {...PASSCODE_BOX}
                hint={SECRET_HINT}
              />
            ) : null}
            <Button testID="delete-confirm" label={plan.title} icon={UserX} kind="red" loading={busy} disabled={busy} onPress={() => (asksSecret ? void deleteIt() : setAsking(true))} />
            <Button testID="delete-keep" label={plan.keep} kind="outline" onPress={navigation.goBack} />
          </View>
        ) : null}
      </View>

      <Sheet testID="delete-sheet" visible={asking} onClose={() => setAsking(false)} title={LOCAL_CONFIRM.title}>
        <Txt v="body" c={color.inkSoft}>{LOCAL_CONFIRM.body}</Txt>
        <Button
          testID="delete-sheet-confirm"
          label="Delete my account"
          kind="red"
          onPress={() => {
            setAsking(false);
            void deleteIt();
          }}
        />
        <Button testID="delete-sheet-keep" label="Keep my account" kind="outline" onPress={() => setAsking(false)} />
      </Sheet>
    </Page>
  );
}

const styles = StyleSheet.create({
  lines: { gap: space.md },
  checking: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  noticeButton: { marginTop: space.sm, alignSelf: 'flex-start', minHeight: 56, paddingHorizontal: space.lg },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
