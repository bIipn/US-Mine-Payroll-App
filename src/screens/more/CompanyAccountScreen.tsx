import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Building2, CloudCheck, CloudUpload, Eye, EyeOff, LogIn, LogOut, RotateCcw, Users, UserX, WifiOff } from '../../components/icons';
import { Button, Field, IconButton, Notice, Panel, Page, Row, Segmented, Sheet, Tag, Txt } from '../../components/ui';
import { WebPageLinks } from '../../components/WebPageLinks';
import { companyAccountView, signInIsTheirs } from '../../domain/access';
import { keepsTime } from '../../domain/company';
import {
  checkEmail,
  checkJoinCode,
  checkJoinName,
  checkPassword,
  joinedAnswer,
  joinWords,
  normalJoinCode,
  pickCompany,
  roleWords,
  spacedJoinCode,
  type JoinAnswer,
  type ServerCompany,
  type WaitingRequest,
} from '../../domain/serverAnswers';
import { cleanText } from '../../domain/roster';
import { receiveWords, syncWords, type SyncStatus } from '../../domain/sync';
import type { ScreenProps } from '../../navigation/types';
import { checkAccount, disconnect, server, useServerAccount } from '../../services/connection';
import { haptic } from '../../services/haptics';
import { syncNow, useSyncStatus } from '../../services/sync';
import { useMe, useStore } from '../../store/useStore';
import { color, font, space } from '../../theme/theme';
import { fmtDate, fmtTime } from '../../util/format';
import { CompanyChoice, EmailSignIn, useConnectCompany, Waiting } from '../auth/ServerSignIn';

type Mode = 'signin' | 'signup';

/**
 * Connecting this phone to the company's server: sign in or make an account,
 * join the company with its join code, then see where the records stand.
 * Only in a build that names a server and is not a preview.
 */
export function CompanyAccountScreen({ navigation }: ScreenProps<'CompanyAccount'>) {
  const linked = useStore((s) => s.connectedCompany);
  const me = useMe();
  const receiving = useStore((s) => s.receiving);
  const { known, account, notOnLinked } = useServerAccount();
  const same = !!linked && !!account && linked.userId === account.id;
  // The company sign-in belongs to the phone's person: who sees what of it (companyAccountView).
  const { view, words } = companyAccountView({ connected: !!linked, me: me ?? null, receiving, serverSignedIn: same });
  // Opened from the sign-in screen to connect: once connected, back to it, to make an account.
  const connectedHere = !!linked;
  const [startedOut] = useState(!linked && !me);
  useEffect(() => {
    if (startedOut && connectedHere) navigation.goBack();
  }, [startedOut, connectedHere, navigation]);

  if (!server) return null;
  return (
    <Page testID="company-account-screen" title="Company account" sub={linked && account ? linked.name : undefined} onBack={navigation.goBack}>
      <View style={{ gap: space.xl }}>
        {view === 'read_only' ? (
          <ReadOnly words={words ?? (me ? 'This phone has not heard from the company yet. It does once it has signal.' : 'Sign in to the app to see this phone’s company account.')} canSend={!!me} />
        ) : !known ? (
          <Waiting text="Looking for the account on this phone…" />
        ) : !account ? (
          <SignInForm />
        ) : !linked ? (
          <JoinForm email={account.email} accountId={account.id} />
        ) : same ? (
          <Connected email={account.email} />
        ) : notOnLinked ? (
          <OtherAccount email={account.email} />
        ) : (
          <Checking email={account.email} />
        )}
      </View>
    </Page>
  );
}

/**
 * Signed out: sign in, which is the company sign-in screen's own email sign-in (ServerSignIn), or make
 * an account.
 */
function SignInForm() {
  const linked = useStore((s) => s.connectedCompany);
  const [mode, setMode] = useState<Mode>('signin');
  // Making an account: its address, its password, and the address the link to confirm it went to.
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTo, setConfirmTo] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'submit' | 'resend' | null>(null);
  if (!server) return null;
  const link = server;
  // Connected to a company: only the account on its roster sends its records, so there is no new account to make here.
  const signUp = mode === 'signup' && !linked;

  const create = async () => {
    const problem = checkEmail(address) ?? checkPassword(password, true);
    if (problem) {
      haptic.error();
      setError(problem);
      return;
    }
    setBusy('submit');
    setError(null);
    const result = await link.signUp(address, password);
    setBusy(null);
    if (!result.ok) {
      haptic.error();
      setError(result.error);
      return;
    }
    haptic.success();
    setPassword('');
    if (result.confirm) {
      // No session until the email is confirmed: the person signs in after opening the link.
      setConfirmTo(address.trim().toLowerCase());
      setMode('signin');
    }
  };

  const resend = async () => {
    if (!confirmTo) return;
    setBusy('resend');
    setResendError(null);
    const result = await link.resendConfirmation(confirmTo);
    setBusy(null);
    if (!result.ok) {
      haptic.error();
      setResendError(result.error);
      return;
    }
    haptic.success();
    useStore.getState().showToast(`Sent the link to ${confirmTo} again.`, 'info');
  };

  return (
    <>
      {linked ? (
        <Notice
          tone="warn"
          icon={LogIn}
          title="Signed out of the company server"
          body={`Sign in${linked.email ? ` as ${linked.email}` : ''} to keep sending this phone’s records to ${linked.name}. They are all saved on this phone meanwhile.`}
        />
      ) : (
        <View style={{ gap: space.xs }}>
          <Txt v="lead">Send this phone’s records to your company</Txt>
          <Txt v="body" c={color.inkSoft}>
            Sign in, or create an account. Then join your company with the code a supervisor gives you. Everything is saved on this phone either way.
          </Txt>
        </View>
      )}
      {confirmTo ? (
        <View testID="server-confirm" style={{ gap: space.sm }}>
          <Notice tone="info" title="Check your email" body={`We sent a link to ${confirmTo}. Open it, then come back here and sign in with the same password.`} />
          <Button testID="server-resend" label="Send the link again" kind="quiet" size="md" loading={busy === 'resend'} onPress={() => void resend()} style={styles.tall} />
          {resendError ? (
            <Txt v="smallStrong" c={color.red} testID="server-resend-error" accessibilityLiveRegion="polite">{resendError}</Txt>
          ) : null}
        </View>
      ) : null}
      <Panel>
        <View style={{ gap: space.lg }}>
          {linked ? null : (
            <Segmented
              testID="server-mode"
              value={mode}
              onChange={(next) => {
                setMode(next);
                setError(null);
              }}
              options={[
                { value: 'signin', label: 'Sign in' },
                { value: 'signup', label: 'Create account' },
              ]}
            />
          )}
          {signUp ? (
            <>
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
                autoComplete="new-password"
                hint="At least 8 characters."
                onSubmitEditing={() => void create()}
                right={
                  <IconButton
                    icon={show ? EyeOff : Eye}
                    label={show ? 'Hide password' : 'Show password'}
                    onPress={() => setShow((v) => !v)}
                    tint={color.silica}
                  />
                }
              />
              {error ? (
                <Txt v="smallStrong" c={color.red} testID="server-error" accessibilityLiveRegion="polite">{error}</Txt>
              ) : null}
              <Button testID="server-submit" label="Create account" icon={LogIn} loading={busy === 'submit'} onPress={() => void create()} />
            </>
          ) : (
            // A phone that is connected signs back in as the account that joined, so its address is filled in.
            <EmailSignIn email={linked?.email ?? address} />
          )}
        </View>
      </Panel>
      {linked ? <DisconnectButton /> : null}
    </>
  );
}

/** Signed in, connected to no company: the companies the account is on, and the join code. */
function JoinForm({ email, accountId }: { email: string; accountId: string }) {
  const me = useMe();
  // A request another account made on this phone is theirs to check on, not this one's.
  const asked = useStore((s) => (s.joinAsked && s.joinAsked.accountId === accountId ? s.joinAsked : null));
  const online = useSyncStatus((s) => s.online);
  const { setJoinAsked } = useStore.getState();
  // Connecting to one of the account's companies, as the company sign-in screen does (ServerSignIn).
  const connector = useConnectCompany({ id: accountId, email });
  const [companies, setCompanies] = useState<ServerCompany[] | null>(null);
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<WaitingRequest[]>([]);
  const [code, setCode] = useState(asked?.code ?? '');
  const [first, setFirst] = useState(asked?.firstName ?? me?.firstName ?? '');
  const [last, setLast] = useState(asked?.lastName ?? me?.lastName ?? '');
  const [error, setError] = useState<string | null>(null);
  // A request still waiting from an earlier visit is shown until it is checked again.
  const [answer, setAnswer] = useState<(JoinAnswer & { code: string }) | null>(
    asked ? { status: 'pending', companyName: asked.companyName, reason: asked.reason, code: asked.code } : null,
  );
  const [busy, setBusy] = useState(false);
  const [tries, setTries] = useState(0);

  // The account's companies, and its requests still waiting: again when signal comes back.
  useEffect(() => {
    let live = true;
    if (!server || !online) return undefined;
    void server.myCompanies().then((result) => {
      if (!live) return;
      setCompanies(result.ok ? result.companies : null);
      setListProblem(result.ok ? null : result.error);
    });
    void server.myJoinRequests().then((result) => {
      if (live && result.ok) setWaiting(result.requests);
    });
    return () => {
      live = false;
    };
  }, [email, online, tries]);

  if (!server) return null;
  const link = server;

  /** What was typed changed: an answer about the old code or name no longer stands. */
  const edited = () => {
    setError(null);
    setAnswer(null);
  };

  const join = async () => {
    setAnswer(null);
    const problem = checkJoinCode(code) ?? checkJoinName(first, last);
    if (problem) {
      haptic.error();
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const typed = normalJoinCode(code);
    const result = await link.joinCompany(typed, cleanText(first), cleanText(last));
    if (!result.ok) {
      setBusy(false);
      haptic.error();
      setError(result.error);
      return;
    }
    setAnswer({ ...result.answer, code: typed });
    if (!joinedAnswer(result.answer)) {
      setBusy(false);
      if (result.answer.status === 'pending') {
        haptic.warning();
        setJoinAsked({
          code: typed,
          firstName: cleanText(first),
          lastName: cleanText(last),
          companyName: result.answer.companyName,
          reason: result.answer.reason,
          accountId,
          at: Date.now(),
        });
      } else {
        haptic.error();
        if (asked?.code === typed) setJoinAsked(null);
      }
      return;
    }
    // On the roster now: find the company among the account's own, and connect to it.
    const mine = await link.myCompanies();
    setBusy(false);
    if (!mine.ok) {
      haptic.error();
      setError(mine.error);
      return;
    }
    setCompanies(mine.companies);
    const company = pickCompany(mine.companies, result.answer);
    if (!company) {
      haptic.error();
      setError('You are on the roster, but this phone could not find the company. Tap Join company again.');
      return;
    }
    if (!connector.connect(company)) setError(null);
  };

  const words = answer && !joinedAnswer(answer) ? joinWords(answer) : null;
  const checking = answer?.status === 'pending' && answer.code === normalJoinCode(code);
  // A request left from another phone, or before this one remembered it: the code has to be typed again.
  const elsewhere = !answer && !asked && waiting.length ? waiting[0] : null;
  return (
    <>
      {listProblem ? (
        <Notice tone="warn" icon={WifiOff} title="Could not load your companies" body={`${listProblem}`}>
          <Button testID="server-companies-retry" label="Try again" icon={RotateCcw} kind="outline" size="md" onPress={() => setTries((n) => n + 1)} style={styles.noticeButton} />
        </Notice>
      ) : null}
      {companies && companies.length ? <CompanyChoice companies={companies} error={connector.error} onPick={(company) => connector.connect(company)} /> : null}

      <Panel title="Join your company">
        <View style={{ gap: space.lg }}>
          <Txt v="body" c={color.inkSoft}>
            A supervisor gives you the join code. A company and its code are set up in the MineMuster office dashboard.
          </Txt>
          {elsewhere ? (
            <Notice
              tone="info"
              title="A request is waiting for a supervisor"
              body={`You asked to join a company on ${fmtDate(elsewhere.at)}. Type its join code again and tap Join company to see where it stands.`}
            />
          ) : null}
          <Field
            testID="server-code"
            label="Join code"
            hint="8 letters and numbers. Your supervisor has it."
            value={code}
            onChangeText={(text) => {
              setCode(text);
              edited();
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={16}
          />
          <View style={styles.names}>
            <View style={{ flex: 1 }}>
              <Field
                testID="server-first"
                label="First name"
                value={first}
                onChangeText={(text) => {
                  setFirst(text);
                  edited();
                }}
                autoCapitalize="words"
                autoComplete="given-name"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                testID="server-last"
                label="Last name"
                value={last}
                onChangeText={(text) => {
                  setLast(text);
                  edited();
                }}
                autoCapitalize="words"
                autoComplete="family-name"
              />
            </View>
          </View>
          <Txt v="small" c={color.silica}>Your name the way it is on the company’s roster.</Txt>
          {words ? (
            <View testID="server-answer">
              <Notice tone={words.tone} title={words.title} body={words.body} />
            </View>
          ) : null}
          {error ? (
            <Txt v="smallStrong" c={color.red} testID="server-error" accessibilityLiveRegion="polite">{error}</Txt>
          ) : null}
          <Button
            testID="server-join"
            label={checking ? 'Check again' : 'Join company'}
            icon={Building2}
            loading={busy}
            onPress={() => void join()}
          />
        </View>
      </Panel>

      {/* Never joined: deleting the company sign-in alone, with its password, whoever is signed in to the app. */}
      <AccountRow email={email} deletes="sign_in" />

      {connector.ask}
    </>
  );
}

/** Another account than the one that joined is signed in, and it is not on the company's roster. */
function OtherAccount({ email }: { email: string }) {
  const linked = useStore((s) => s.connectedCompany);
  if (!linked) return null;
  return (
    <>
      <View testID="server-other-account">
        <Notice
          tone="bo"
          title={`This account is not on ${linked.name}’s roster`}
          body={`This phone sends ${linked.name}’s records only as an account on its roster${linked.email ? `, such as ${linked.email}` : ''}. Sign out and sign in as that account, or disconnect this phone. Nothing is sent meanwhile, and nothing is lost.`}
        />
      </View>
      <AccountRow email={email} />
      <DisconnectButton />
    </>
  );
}

/** Another account is signed in: checking it against the company's roster before anything is sent as it. */
function Checking({ email }: { email: string }) {
  const linked = useStore((s) => s.connectedCompany);
  const { checking, unchecked } = useServerAccount();
  useEffect(() => checkAccount(), []);
  if (!linked) return null;
  return (
    <>
      {unchecked && !checking ? (
        <Notice tone="warn" icon={WifiOff} title={`Could not check ${email} with ${linked.name}`} body="This needs signal. Nothing is sent until it is checked, and nothing is lost.">
          <Button testID="server-check-retry" label="Try again" icon={RotateCcw} kind="outline" size="md" onPress={checkAccount} style={styles.noticeButton} />
        </Notice>
      ) : (
        <Waiting text={`Checking that ${email} is on ${linked.name}’s roster…`} />
      )}
      <AccountRow email={email} />
    </>
  );
}

/** Connected: the company, the role, where the records stand, and disconnecting. */
function Connected({ email }: { email: string }) {
  const linked = useStore((s) => s.connectedCompany);
  const time = useStore((s) => keepsTime(s.settings.company));
  const joinCode = useServerAccount((s) => s.joinCode);
  const notOnLinked = useServerAccount((s) => s.notOnLinked);
  const sync = useSyncStatus();
  const me = useMe();
  const receiving = useStore((s) => s.receiving);
  // Deleting the sign-in is its own person's: by the name the company has for it.
  const theirs = !!me && signInIsTheirs(me, receiving ? { role: receiving.role, name: receiving.name } : null);
  // The role, the company's name and a supervisor's join code, as the server has them now.
  useEffect(() => checkAccount(), []);
  if (!linked) return null;
  const records = syncWords(sync, fmtTime);
  const RecordsIcon = !sync.online ? WifiOff : records.done ? CloudCheck : CloudUpload;
  const supervisor = linked.role === 'supervisor';
  const fromCompany = receiveLine(sync, linked.name, linked.email ?? null);

  return (
    <>
      {notOnLinked ? (
        <View testID="server-off-roster">
          <Notice
            tone="bo"
            title={`${email} is not on ${linked.name}’s roster now`}
            body="The server takes nothing more from this account. See your supervisor. Everything stays saved on this phone."
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
            <Txt v="small" c={color.silica}>Signed in as {email}</Txt>
          </View>
        </View>
      </Panel>

      {supervisor && joinCode ? (
        <Panel title="Join code">
          <View style={{ gap: space.sm }} testID="server-join-code">
            <Txt v="body" style={styles.code} selectable>{spacedJoinCode(joinCode)}</Txt>
            <Txt v="small" c={color.silica}>Give this to your crew. They join {linked.name} with it and their name as it is on the roster.</Txt>
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

      <DisconnectButton />
      <AccountRow email={email} deletes={theirs ? 'account' : undefined} />
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

/** Disconnecting, asked first. */
function DisconnectButton() {
  const linked = useStore((s) => s.connectedCompany);
  const showToast = useStore((s) => s.showToast);
  const sync = useSyncStatus();
  const [asking, setAsking] = useState(false);
  if (!linked) return null;
  return (
    <>
      <Button testID="server-disconnect" label="Disconnect this phone" icon={LogOut} kind="outline" onPress={() => setAsking(true)} />
      <Sheet testID="server-disconnect-sheet" visible={asking} onClose={() => setAsking(false)} title="Disconnect this phone?">
        <Txt v="body" c={color.inkSoft}>
          This phone stops sending records to {linked.name} and signs out of the company server. Everything stays saved on this phone.
        </Txt>
        {sync.server && sync.waiting > 0 ? (
          <Txt v="strong" c={color.red} testID="server-unsent">
            {sync.waiting} {sync.waiting === 1 ? 'record has' : 'records have'} not reached the server yet. {sync.waiting === 1 ? 'It sends' : 'They send'} if you connect again.
          </Txt>
        ) : null}
        <Button
          testID="server-confirm-disconnect"
          label="Disconnect"
          kind="red"
          onPress={() => {
            setAsking(false);
            void disconnect().then(() => showToast('Disconnected. Everything stays saved on this phone.', 'info'));
          }}
        />
        <Button testID="server-keep" label="Keep connected" kind="outline" onPress={() => setAsking(false)} />
      </Sheet>
    </>
  );
}

/**
 * Who is signed in to the server on this phone, and signing out. With `deletes`, deleting: `sign_in`,
 * the company sign-in alone, on a phone that never joined a company; `account`, the person's whole
 * account with their own sign-in, on one joined with it.
 */
function AccountRow({ email, deletes }: { email: string; deletes?: 'sign_in' | 'account' }) {
  const navigation = useNavigation();
  return (
    <View style={{ gap: space.md }}>
      <Panel flush>
        <Row testID="server-account" left={<Users color={color.ink} size={24} />} title={email} sub="Signed in to the company server" subLines={3} />
      </Panel>
      <Button testID="server-sign-out" label="Sign out of the server" icon={LogOut} kind="quiet" onPress={() => void server?.signOut()} />
      {deletes === 'sign_in' ? (
        <Button testID="server-delete-sign-in" label="Delete this company sign-in" icon={UserX} kind="quiet" onPress={() => navigation.navigate('DeleteAccount', { signInOnly: true })} />
      ) : deletes === 'account' ? (
        <Button testID="server-delete-sign-in" label="Delete my account" icon={UserX} kind="quiet" onPress={() => navigation.navigate('DeleteAccount')} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  names: { flexDirection: 'row', gap: space.md },
  company: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  tagLine: { flexDirection: 'row' },
  code: { fontFamily: font.condBold, fontSize: 40, lineHeight: 46, letterSpacing: 4, color: color.ink },
  noticeButton: { marginTop: space.sm, alignSelf: 'flex-start', minHeight: 56, paddingHorizontal: space.lg },
  // The quiet buttons here are a full tap target for a gloved thumb.
  tall: { minHeight: 56 },
});
