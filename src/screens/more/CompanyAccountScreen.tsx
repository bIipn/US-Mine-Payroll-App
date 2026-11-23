import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Building2, CloudCheck, CloudUpload, HardHat, LogIn, LogOut, RotateCcw, UserCog, UserX, WifiOff } from '../../components/icons';
import { Button, Notice, Panel, Page, Row, Tag, Txt } from '../../components/ui';
import { WebPageLinks } from '../../components/WebPageLinks';
import { companyAccountView, signInIsTheirs } from '../../domain/access';
import { keepsTime } from '../../domain/company';
import { roleWords, spacedJoinCode } from '../../domain/serverAnswers';
import { receiveWords, syncWords, type SyncStatus } from '../../domain/sync';
import type { ScreenProps } from '../../navigation/types';
import { checkAccount, server, useServerAccount, type AccountState } from '../../services/connection';
import { syncNow, useSyncStatus } from '../../services/sync';
import { useMe, useStore } from '../../store/useStore';
import { color, font, space, TAP } from '../../theme/theme';
import { fmtTime, fullName } from '../../util/format';
import { CrewSignIn, keepCrewSession, passcodesHere } from '../auth/CrewSignIn';
import { EmailSignIn, Waiting } from '../auth/ServerSignIn';
import { SignOutSheet } from './SignOutOfPhone';

type ServerAccount = NonNullable<AccountState['account']>;

/**
 * Where this phone stands with its company's server: the company and the role, where the records stand,
 * what is sent and what is received, signing out of this phone and deleting the account. A phone is
 * joined to its company from the company sign-in screen; here a company sign-in that is signed out of the
 * server signs in again, with the company code, the name and the passcode (crew) or the email and password
 * (supervisors). A crew member's sign-in is named by the person's name, never by an address. Only in a
 * build that names a server and is not a preview.
 */
export function CompanyAccountScreen({ navigation }: ScreenProps<'CompanyAccount'>) {
  const linked = useStore((s) => s.connectedCompany);
  const me = useMe();
  const receiving = useStore((s) => s.receiving);
  const { known, account, notOnLinked } = useServerAccount();
  const same = !!linked && !!account && linked.userId === account.id;
  // The company sign-in belongs to the phone's person: who sees what of it (companyAccountView).
  const { view, words } = companyAccountView({ connected: !!linked, me: me ?? null, receiving, serverSignedIn: same });

  if (!server) return null;
  return (
    <Page testID="company-account-screen" title="Company account" sub={linked ? linked.name : undefined} onBack={navigation.goBack}>
      <View style={{ gap: space.xl }}>
        {view === 'read_only' ? (
          <ReadOnly words={words ?? (me ? 'This phone has not heard from the company yet. It does once it has signal.' : 'Sign in to the app to see this phone’s company account.')} canSend={!!me} />
        ) : !known ? (
          <Waiting text="Looking for the sign-in on this phone…" />
        ) : !linked ? (
          <NotConnected />
        ) : !account ? (
          <SignInAgain />
        ) : same ? (
          <Connected account={account} />
        ) : notOnLinked ? (
          <OtherAccount />
        ) : (
          <Checking />
        )}
      </View>
    </Page>
  );
}

/** The person a phone's company sign-in is, by the name the company has for it, or the person signed in here. */
function useSignInName(): string | null {
  const name = useStore((s) => s.receiving?.name ?? null);
  const me = useMe();
  return name ? `${name.firstName} ${name.lastName}` : me ? fullName(me) : null;
}

/**
 * Signed in to the app on a phone joined to no company: an account from before the company sign-in, say.
 * Everything on it stays here; it is joined to the company by signing in on the company sign-in screen.
 */
function NotConnected() {
  return (
    <>
      <View testID="company-not-connected">
        <Notice
          tone="info"
          icon={Building2}
          title="This phone is not connected to a company"
          body="Everything on it stays saved here. To send it to your company, sign out of this phone, then sign in with your company code, or as a supervisor with email."
        />
      </View>
      <SignOutButton />
    </>
  );
}

/**
 * The phone's company sign-in is signed out of the server: nothing is sent until it signs in again, and it
 * all waits on the phone. A supervisor's sign-in is by email and password, its address filled in. A crew
 * member's is the company code, their name and their passcode (the company sign-in screen's own form), or
 * email for one who signed up with an email before passcodes; on the web it is email alone, as crew-auth
 * turns down a web page.
 */
function SignInAgain() {
  const linked = useStore((s) => s.connectedCompany);
  const [withEmail, setWithEmail] = useState(false);
  if (!linked) return null;
  // A supervisor's sign-in is always by email (a passcode sign-in never holds a supervisor's row), so its
  // address is filled in; anyone else's is typed, so no address is ever filled in for a passcode sign-in.
  const supervisor = linked.role === 'supervisor';
  const byEmail = supervisor || withEmail || !passcodesHere();
  return (
    <>
      <Notice
        tone="warn"
        icon={LogIn}
        title="Signed out of the company server"
        body={`Sign in again to keep sending this phone’s records to ${linked.name}. They are all saved on this phone meanwhile. Signing in needs signal.`}
      />
      <Panel title="Sign in again">
        <View testID="company-sign-in-again">
          {byEmail ? <EmailSignIn email={supervisor ? linked.email ?? '' : ''} /> : <CrewSignIn onSignedIn={keepCrewSession} startOn="sign_in" />}
        </View>
      </Panel>
      {supervisor || !passcodesHere() ? null : (
        <Panel flush>
          {withEmail ? (
            <Row testID="company-again-with-code" left={<HardHat color={color.ink} size={24} />} title="Sign in with the company code and your passcode" chevron onPress={() => setWithEmail(false)} />
          ) : (
            <Row testID="company-again-with-email" left={<UserCog color={color.ink} size={24} />} title="Signed up with email? Sign in with email" chevron onPress={() => setWithEmail(true)} />
          )}
        </Panel>
      )}
      <SignOutButton />
    </>
  );
}

/** Another account than the one that joined is signed in, and it is not on the company's roster. */
function OtherAccount() {
  const linked = useStore((s) => s.connectedCompany);
  const name = useStore((s) => s.receiving?.name ?? null);
  if (!linked) return null;
  const whose = name ? `${name.firstName} ${name.lastName}’s company sign-in` : 'the company sign-in it was joined with';
  return (
    <>
      <View testID="server-other-account">
        <Notice
          tone="bo"
          title={`This sign-in is not on ${linked.name}’s roster`}
          body={`This phone sends ${linked.name}’s records only with ${whose}. Sign out of the company server, then sign in again with that one. Nothing is sent meanwhile, and nothing is lost.`}
        />
      </View>
      <SignOutOfServer />
    </>
  );
}

/** Another account is signed in: checking it against the company's roster before anything is sent as it. */
function Checking() {
  const linked = useStore((s) => s.connectedCompany);
  const { checking, unchecked } = useServerAccount();
  useEffect(() => checkAccount(), []);
  if (!linked) return null;
  return (
    <>
      {unchecked && !checking ? (
        <Notice tone="warn" icon={WifiOff} title={`Could not check this sign-in with ${linked.name}`} body="This needs signal. Nothing is sent until it is checked, and nothing is lost.">
          <Button testID="server-check-retry" label="Try again" icon={RotateCcw} kind="outline" size="md" onPress={checkAccount} style={styles.noticeButton} />
        </Notice>
      ) : (
        <Waiting text={`Checking this sign-in with ${linked.name}…`} />
      )}
      <SignOutOfServer />
    </>
  );
}

/** Connected: the company, the role, who is signed in, where the records stand, signing out and deleting. */
function Connected({ account }: { account: ServerAccount }) {
  const navigation = useNavigation();
  const linked = useStore((s) => s.connectedCompany);
  const time = useStore((s) => keepsTime(s.settings.company));
  const joinCode = useServerAccount((s) => s.joinCode);
  const notOnLinked = useServerAccount((s) => s.notOnLinked);
  const sync = useSyncStatus();
  const me = useMe();
  const receiving = useStore((s) => s.receiving);
  const who = useSignInName();
  // Deleting the sign-in is its own person's: by the name the company has for it.
  const theirs = !!me && signInIsTheirs(me, receiving ? { role: receiving.role, name: receiving.name } : null);
  // The role, the company's name and a supervisor's join code, as the server has them now.
  useEffect(() => checkAccount(), []);
  if (!linked) return null;
  const records = syncWords(sync, fmtTime);
  const RecordsIcon = !sync.online ? WifiOff : records.done ? CloudCheck : CloudUpload;
  const supervisor = linked.role === 'supervisor';
  // A crew member's sign-in has no address to show: the person's name says whose it is.
  const address = account.kind === 'email' ? account.email : '';
  const fromCompany = receiveLine(sync, linked.name, address || null);

  return (
    <>
      {notOnLinked ? (
        <View testID="server-off-roster">
          <Notice
            tone="bo"
            title={`This phone’s company sign-in is not on ${linked.name}’s roster now`}
            body="The server takes nothing more from it. See your supervisor. Everything stays saved on this phone."
          />
        </View>
      ) : null}
      <Panel>
        <View style={styles.company}>
          <Building2 color={color.ink} size={32} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Txt v="h3" testID="server-company-name">{linked.name}</Txt>
            <View style={styles.tagLine}>
              <Tag label={roleWords(linked.role)} tone={supervisor ? 'ink' : 'neutral'} solid={supervisor} />
            </View>
            <Txt v="small" c={color.silica} testID="server-signed-in-as">{who ? `Signed in as ${who}` : 'Signed in to the company server'}</Txt>
            <Txt v="small" c={color.silica}>{address ? `With ${address}` : 'With the company code and a passcode'}</Txt>
          </View>
        </View>
      </Panel>

      {supervisor && joinCode ? (
        <Panel title="Company code">
          <View style={{ gap: space.sm }} testID="server-join-code">
            <Txt v="body" style={styles.code} selectable>{spacedJoinCode(joinCode)}</Txt>
            <Txt v="small" c={color.silica}>{`Give this to your crew. They sign in to ${linked.name} with it, their name as it is on the roster, and a passcode of their own.`}</Txt>
          </View>
        </Panel>
      ) : null}

      <Panel title="Records on this phone" flush>
        <Row
          testID="server-sync"
          left={<RecordsIcon color={color.ink} size={24} />}
          title={records.title}
          sub={fromCompany ? `${records.sub}\n${fromCompany.line}` : records.sub}
          subColor={records.warn || fromCompany?.warn ? color.red : undefined}
          subLines={6}
        />
      </Panel>
      <SendAndReceive />

      <Panel title="What this phone receives">
        <View style={{ gap: space.sm }} testID="server-what-received">
          <Txt v="body">The roster, the fleet, the area sheets and the company’s settings, as the office keeps them on the dashboard. They come whenever this phone is open with signal, and every five minutes while it is.</Txt>
          <Txt v="small" c={color.silica}>People are added, taken off and given a role or a payroll ID on the dashboard’s Roster page.</Txt>
        </View>
      </Panel>

      <Panel title="What is sent">
        <View style={{ gap: space.sm }} testID="server-what-sent">
          <Txt v="body">
            {time
              ? 'Punches, equipment checklists, pre shift exams, maintenance requests and paid leave; and from a supervisor’s sign-in, changes to the fleet, the area sheets and the company’s settings.'
              : 'Equipment checklists, pre shift exams and maintenance requests; and from a supervisor’s sign-in, changes to the fleet, the area sheets and the company’s settings.'}
          </Txt>
          <Txt v="body">
            {time
              ? 'Never sent: your hourly rate, the app’s own sign-in names and passwords on this phone, and this phone’s own settings, such as lunch reminders.'
              : 'Never sent: the app’s own sign-in names and passwords on this phone, and this phone’s own settings.'}
          </Txt>
          {supervisor ? null : (
            <Txt v="small" c={color.silica}>
              {time
                ? 'The area sheets, paid leave and the company’s settings are a supervisor’s to change, so the server takes them from a supervisor’s sign-in only. What it does not take stays on this phone and is listed on More.'
                : 'The area sheets and the company’s settings are a supervisor’s to change, so the server takes them from a supervisor’s sign-in only. What it does not take stays on this phone and is listed on More.'}
            </Txt>
          )}
        </View>
      </Panel>

      <WebPageLinks testID="server-pages" />

      <SignOutButton />
      {theirs ? (
        <Button testID="server-delete-sign-in" label="Delete my account" icon={UserX} kind="quiet" style={styles.tall} onPress={() => navigation.navigate('DeleteAccount')} />
      ) : null}
    </>
  );
}

/** The records row's line about what comes from the company. */
function receiveLine(sync: SyncStatus, company: string, email: string | null) {
  const receiving = useStore.getState().receiving;
  return receiveWords(
    {
      connected: true,
      online: sync.online,
      role: receiving?.role ?? null,
      caughtUpAt: receiving?.caughtUpAt ?? null,
      closed: sync.trouble === 'closed',
      unreadable: receiving?.unreadable.length ?? 0,
      notTaken: sync.notTaken,
      company,
      email,
    },
    fmtTime,
  );
}

/** Send what waits and read what the company changed, now. */
function SendAndReceive() {
  const sync = useSyncStatus();
  if (!sync.server || !sync.online || sync.sending) return null;
  return <Button testID="server-send-now" label="Send and receive now" icon={CloudUpload} kind="outline" onPress={() => void syncNow()} />;
}

/**
 * The company account of a phone whose company sign-in belongs to someone else, or with nobody
 * signed in to the app: the company and where its records stand, and nothing that changes the sign-in.
 */
function ReadOnly({ words, canSend }: { words: string; canSend: boolean }) {
  const linked = useStore((s) => s.connectedCompany);
  const sync = useSyncStatus();
  if (!linked) return null;
  const records = syncWords(sync, fmtTime);
  const fromCompany = receiveLine(sync, linked.name, null);
  return (
    <>
      <Panel>
        <View style={styles.company}>
          <Building2 color={color.ink} size={32} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Txt v="h3" testID="server-company-name">{linked.name}</Txt>
            <Txt v="small" c={color.silica}>{words}</Txt>
          </View>
        </View>
      </Panel>
      <Panel title="Records on this phone" flush>
        <Row
          testID="server-sync"
          left={<CloudUpload color={color.ink} size={24} />}
          title={records.title}
          sub={fromCompany ? `${records.sub}\n${fromCompany.line}` : records.sub}
          subColor={records.warn || fromCompany?.warn ? color.red : undefined}
          subLines={6}
        />
      </Panel>
      {canSend ? <SendAndReceive /> : null}
    </>
  );
}

/**
 * Sign out of this phone, asked first (SignOutSheet): the same as More's Sign out. It waits until everything
 * on the phone has reached the company, then empties the phone and signs out of the server.
 */
function SignOutButton() {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button testID="server-sign-out-phone" label="Sign out of this phone" icon={LogOut} kind="outline" onPress={() => setAsking(true)} />
      <SignOutSheet visible={asking} onClose={() => setAsking(false)} from="company_account" />
    </>
  );
}

/** Sign another account out of the server, so the phone's own company sign-in can sign in again. Nothing on the phone changes. */
function SignOutOfServer() {
  return <Button testID="server-sign-out" label="Sign out of the company server" icon={LogOut} kind="quiet" style={styles.tall} onPress={() => void server?.signOut()} />;
}

const styles = StyleSheet.create({
  company: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  tagLine: { flexDirection: 'row' },
  code: { fontFamily: font.condBold, fontSize: 40, lineHeight: 46, letterSpacing: 4, color: color.ink },
  noticeButton: { marginTop: space.sm, alignSelf: 'flex-start', minHeight: TAP, paddingHorizontal: space.lg },
  // The quiet buttons here are a full tap target for a gloved thumb.
  tall: { minHeight: TAP },
});
