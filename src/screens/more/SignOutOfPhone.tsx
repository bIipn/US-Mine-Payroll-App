import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CloudUpload, LogOut, OctagonAlert, RotateCcw, TriangleAlert } from '../../components/icons';
import { Button, Divider, Notice, Panel, Sheet, Txt } from '../../components/ui';
import { signOutWarnings, signOutWords, type Blocker } from '../../domain/accountDeletion';
import { keepsTime } from '../../domain/company';
import type { HeldReason } from '../../domain/receive';
import type { Change } from '../../domain/sync';
import { signOutOfPhone, type PhoneSignOut } from '../../services/connection';
import { haptic } from '../../services/haptics';
import { notTakenChanges, stuckChanges, syncNow, useSyncStatus, waitingChanges } from '../../services/sync';
import { staleShiftOf, useStore } from '../../store/useStore';
import { color, space, TAP } from '../../theme/theme';
import { fmtDate } from '../../util/format';
import { NotTakenRow } from './NotTakenRow';

/**
 * Signing out of this phone, asked first (More's Sign out, and Company account's), and what holds it up
 * when it is refused, each with the button that deals with it. One person per phone: signing out empties
 * the phone, so it waits until everything on it has reached the company (signOutOfPhone). Only in a build
 * that names a server and is not a preview: More loads this behind the same folded condition as the server
 * code, and the company sign-in screen and Company account are behind it already.
 */

/** Signing out of this phone, held up by what is on it. */
export type HeldUp = Extract<PhoneSignOut, { ok: false }>;
type Action = NonNullable<Blocker['action']>;
/** What each blocker's button does on this screen: a screen gives the ones it can do here. Send now is this file's own. */
export type BlockerActions = Partial<Record<Exclude<Action, 'send'>, () => void>>;

const BUTTON: Partial<Record<Action, string>> = {
  clock: 'Go to Clock',
  send: 'Send now',
  checklists: 'Go to Checklists',
  delete: 'Delete my account',
  sign_in: 'Sign in again',
};

/**
 * What holds signing out of this phone up: each blocker with its button, where this screen can do what it
 * says, and under what the company turned down, every one of those records. The list on More leaves out the
 * ones the person marked Done, which still hold signing out up, so every one is named here. From a sign-in
 * off the company's roster nothing reaches the company, so under that every record it counts is named.
 */
export function SignOutHeldUp({ held, actions }: { held: HeldUp; actions: BlockerActions }) {
  const sync = useSyncStatus();
  const sendNow = sync.online && !sync.sending ? () => void syncNow() : undefined;
  const act = (action: Action | undefined) => (action === 'send' ? sendNow : action ? actions[action] : undefined);
  return (
    <View style={styles.list} testID="sign-out-held">
      {held.blockers.length ? (
        held.blockers.map((blocker) => {
          const onPress = act(blocker.action);
          return (
            <View key={blocker.kind} testID={`sign-out-blocker-${blocker.kind}`}>
              <Notice tone="warn" icon={OctagonAlert} title={blocker.title} body={blocker.body}>
                {onPress && blocker.action ? (
                  <Button
                    testID={`sign-out-${blocker.action}`}
                    label={BUTTON[blocker.action] ?? ''}
                    icon={blocker.action === 'send' ? CloudUpload : undefined}
                    kind="outline"
                    size="md"
                    onPress={onPress}
                    style={styles.noticeButton}
                  />
                ) : null}
              </Notice>
              {blocker.kind === 'not_taken' || blocker.kind === 'not_member' ? <TurnedDown offRoster={blocker.kind === 'not_member'} /> : null}
            </View>
          );
        })
      ) : (
        <Notice tone="warn" icon={OctagonAlert} title={held.error} />
      )}
      {held.warnings.map((line) => (
        <Notice key={line} tone="warn" icon={TriangleAlert} title={line} />
      ))}
    </View>
  );
}

/**
 * Every record the company turned down that holds signing out up, with why: Done on More or not. From a
 * sign-in off its roster (`offRoster`), also every record waiting, none of which can reach it. Read as the
 * list above it is drawn, which follows the round.
 */
function TurnedDown({ offRoster }: { offRoster: boolean }) {
  const held = useStore((s) => s.receiving?.held);
  const records: { change: Change; reason: HeldReason | 'off_roster' }[] = [
    ...notTakenChanges().map((change) => ({ change, reason: held?.[change.key]?.reason ?? ('supervisor_only' as const) })),
    ...(offRoster
      ? waitingChanges().map((change) => ({ change, reason: 'off_roster' as const }))
      : // What the server will not take as it is: the words for a record it could not take as it was.
        stuckChanges().map((change) => ({ change, reason: 'malformed' as const }))),
  ];
  if (!records.length) return null;
  return (
    <Panel flush style={styles.records}>
      {records.map(({ change, reason }, i) => (
        <View key={change.key}>
          {i > 0 ? <Divider inset={space.lg} /> : null}
          <NotTakenRow testID={`sign-out-record-${change.key}`} change={change} reason={reason} />
        </View>
      ))}
    </Panel>
  );
}

export interface SignOutSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Where it opens: on Company account, Sign in again is on the screen behind it. */
  from: 'more' | 'company_account';
}

/** Sign out of this phone?, with what it does and that signing back in needs signal, and once asked, what holds it up. */
export function SignOutSheet({ visible, onClose, from }: SignOutSheetProps) {
  const navigation = useNavigation();
  const company = useStore((s) => s.connectedCompany?.name || s.settings.company.name);
  const connected = useStore((s) => !!s.connectedCompany);
  const time = useStore((s) => keepsTime(s.settings.company));
  const hasRate = useStore((s) => !!s.session && s.payRates[s.session.employeeId] != null);
  // An old shift never clocked out holds nothing up, so it is said before anything is emptied.
  const staleShift = useStore((s) => (s.session ? staleShiftOf(s.shifts, s.session.employeeId, Date.now()) : undefined));
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<HeldUp | null>(null);
  // Signed out, the phone is emptied and the screen this opened on is gone.
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!visible) setHeld(null);
  }, [visible]);
  const words = signOutWords({ company, connected, keepsTime: time, hasRate });

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const done = await signOutOfPhone();
      if (!live.current) return;
      if (done.ok) {
        onClose();
        return;
      }
      haptic.error();
      setHeld(done);
    } catch {
      // Failed outright: nothing was signed out, and it can be tried again.
      if (!live.current) return;
      haptic.error();
      setHeld({ ok: false, reason: 'refused', error: words.failed, blockers: [], warnings: [] });
    } finally {
      // Never left loading, whatever became of it.
      if (live.current) setBusy(false);
    }
  };

  /** Off to where the thing that holds it up is dealt with: the sheet closes first. */
  const away = (go: () => void) => () => {
    onClose();
    go();
  };
  const actions: BlockerActions = {
    clock: away(() => navigation.navigate('Main', { screen: 'Clock' })),
    // The Checklists screen keeps the list it was last on: the equipment list is asked for.
    checklists: away(() => navigation.navigate('Main', { screen: 'Equipment', params: { tab: 'equipment', at: Date.now() } })),
    delete: away(() => navigation.navigate('DeleteAccount')),
    sign_in: from === 'more' ? away(() => navigation.navigate('CompanyAccount')) : onClose,
  };

  return (
    <Sheet testID="sign-out-sheet" visible={visible} onClose={onClose} title={held ? words.held : words.title}>
      {held ? (
        <View style={styles.list}>
          <Txt v="body" c={color.inkSoft}>{words.heldBody}</Txt>
          <SignOutHeldUp held={held} actions={actions} />
        </View>
      ) : (
        <View style={styles.words} testID="sign-out-words">
          <Txt v="body" c={color.inkSoft}>{words.body}</Txt>
          {connected
            ? signOutWarnings({ staleShift, fmtDay: fmtDate }).map((line) => <Notice key={line} tone="warn" icon={TriangleAlert} title={line} />)
            : null}
          <Txt v="strong">{words.signal}</Txt>
        </View>
      )}
      {busy ? (
        <Txt v="small" c={color.silica} testID="sign-out-busy">
          {connected ? 'Sending what is waiting first…' : 'Signing out…'}
        </Txt>
      ) : null}
      <Button testID="sign-out-confirm" label={held ? 'Try again' : words.confirm} icon={held ? RotateCcw : LogOut} kind="red" loading={busy} onPress={() => void signOut()} />
      <Button testID="sign-out-keep" label={words.keep} kind="outline" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.md },
  words: { gap: space.sm },
  records: { marginTop: space.sm },
  noticeButton: { marginTop: space.sm, alignSelf: 'flex-start', minHeight: TAP, paddingHorizontal: space.lg },
});
