import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Building2, Clock, HardHat, LogOut, RotateCcw, UserCog, UserX, WifiOff } from '../../components/icons';
import { SignInHeader, signInStyles } from '../../components/SignInHeader';
import { Button, Notice, Panel, Row, Txt } from '../../components/ui';
import { WebPageLinks } from '../../components/WebPageLinks';
import { ownPersonHere, signInPerson } from '../../domain/access';
import type { ConnectedCompany } from '../../domain/server';
import { joinWords, pickCompany, type ServerCompany, type WaitingRequest } from '../../domain/serverAnswers';
import type { ScreenProps } from '../../navigation/types';
import { checkAccount, disconnect, server, useServerAccount, type AccountState } from '../../services/connection';
import { syncNow, useSyncStatus } from '../../services/sync';
import { useStore } from '../../store/useStore';
import { color, space, TAP } from '../../theme/theme';
import { CrewSignIn, type CrewTyped, type SignedIn } from './CrewSignIn';
import { CompanyChoice, EmailSignIn, useConnectCompany, Waiting } from './ServerSignIn';

type ServerAccount = NonNullable<AccountState['account']>;
/** The company a crew sign-in named, for the account it signed in. */
type Hint = { userId: string; company: { id: string; name: string } | null };

/** Passcodes are offered on iOS and Android only: crew-auth turns down a request from a web page. */
const onPhone = () => Platform.OS === 'ios' || Platform.OS === 'android';

const OTHERS_STILL_IN = 'You are signed in. Any other phone signed in as you could not be signed out. If one is lost, tell a supervisor.';

/**
 * The first screen of a build that connects to a company server (CAN_CONNECT). Crew type the company's
 * code, then sign up with their name and a passcode, or sign in with their name and passcode
 * (CrewSignIn); supervisors sign in with email. The phone keeps the session it is handed, finds the
 * person's company among the account's own and connects to it, and once a round has read the company's
 * records the store opens the person's own account by itself (openOwnAccount): no second account and no
 * second password. Until then this says where things stand: waiting for a supervisor, off the roster, or
 * getting the company's records, with a way out of each. It is in a build only behind the folded
 * condition the server code is behind (RootNavigator), and the public preview carries none of it.
 */
export function CompanySignInScreen({ navigation }: ScreenProps<'CompanySignIn'>) {
  const insets = useSafeAreaInsets();
  const company = useStore((s) => s.settings.company);
  const linked = useStore((s) => s.connectedCompany);
  const { known, account } = useServerAccount();
  const [hint, setHint] = useState<Hint | null>(null);
  const [withEmail, setWithEmail] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  if (!server) return null;
  const link = server;
  const phone = onPhone();
  const deleteAccount = () => navigation.navigate('DeleteAccount');
  const deleteSignIn = () => navigation.navigate('DeleteAccount', { signInOnly: true });

  /**
   * Sign this phone out of the company server, back to the company code. Until the server's sign-out is
   * over the account is still signed in here, so the card says the phone is signing out, and nothing
   * looks for the company or connects to it meanwhile. Nothing on the phone is lost: what it holds stays
   * on it (disconnect). Someone taken off the roster can still have their account open here, though this
   * screen is all they are shown; it is closed too, so the app does not open again for them once the
   * phone is no longer connected.
   */
  const signOutOfPhone = () => {
    if (signingOut) return;
    setSigningOut(true);
    useStore.getState().signOut();
    void disconnect().finally(() => setSigningOut(false));
  };

  /**
   * Keep the session a crew sign-in answered, and say what went wrong if it could not be kept. Which
   * company it named is noted first, as the account is signed in the moment the session is kept.
   */
  const keep = async (answer: SignedIn, typed: CrewTyped, afterReset: boolean): Promise<string | null> => {
    setHint({ userId: answer.session.userId, company: answer.company });
    if (answer.waiting && answer.company) {
      // So the request can be checked on, with its company named, after the app is closed and opened again.
      useStore.getState().setJoinAsked({
        code: typed.code,
        firstName: typed.firstName,
        lastName: typed.lastName,
        companyName: answer.company.name,
        ...(answer.join?.reason ? { reason: answer.join.reason } : null),
        accountId: answer.session.userId,
        at: Date.now(),
      });
    }
    const kept = await link.startCrewSession(answer.session);
    if (!kept.ok) return kept.error;
    // A new passcode: once the account's other sessions are signed out, a lost or old phone stops working.
    if (afterReset || !answer.othersSignedOut) {
      const others = await link.signOutOtherSessions();
      if (!others.ok) useStore.getState().showToast(OTHERS_STILL_IN, 'warn');
    }
    return null;
  };

  const signedOut = known && !account && !signingOut;

  return (
    <KeyboardAvoidingView style={signInStyles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView testID="company-sign-in" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}>
        {/* A store build starts with no company: nothing is said of time or pay until the phone has the company's settings. */}
        <SignInHeader company={company.name.trim() ? company : null} />

        <View style={signInStyles.card}>
          {signingOut ? (
            <Waiting testID="company-signing-out" text="Signing out of this phone…" />
          ) : !known ? (
            <Waiting text="Looking for your sign-in on this phone…" />
          ) : !account ? (
            phone && !withEmail ? (
              <CrewSignIn onSignedIn={keep} />
            ) : (
              <SupervisorSignIn web={!phone} />
            )
          ) : !linked ? (
            <FindCompany
              account={account}
              hint={hint?.userId === account.id ? hint.company : null}
              onDeleteAccount={deleteAccount}
              onDeleteSignIn={deleteSignIn}
              onSignOut={signOutOfPhone}
            />
          ) : (
            <Opening account={account} linked={linked} onDeleteAccount={deleteAccount} onSignOut={signOutOfPhone} />
          )}
        </View>

        {signedOut && phone ? (
          <View style={styles.below}>
            <Panel flush>
              {withEmail ? (
                <Row testID="crew-use-code" left={<HardHat color={color.ink} size={24} />} title="Crew? Sign in with the company code" chevron onPress={() => setWithEmail(false)} />
              ) : (
                <Row testID="crew-use-email" left={<UserCog color={color.ink} size={24} />} title="Supervisor? Sign in with email" chevron onPress={() => setWithEmail(true)} />
              )}
            </Panel>
          </View>
        ) : null}

        <View style={styles.below}>
          <WebPageLinks testID="company-sign-in-pages" />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Supervisors, and any account that already signs in with email. On the web it is the only way in. */
function SupervisorSignIn({ web }: { web: boolean }) {
  return (
    <View style={styles.gap}>
      {web ? (
        <Notice
          tone="info"
          icon={HardHat}
          title="Crew sign in with the MineMuster app on their phone"
          body="With the company code, their name and a passcode. Supervisors sign in here."
        />
      ) : null}
      <View style={styles.gapSmall}>
        <Txt v="h3">{web ? 'Supervisor? Sign in with email' : 'Sign in with email'}</Txt>
        <Txt v="small" c={color.inkSoft}>The email and password you use on the office dashboard.</Txt>
      </View>
      <EmailSignIn />
    </View>
  );
}

type Found =
  | { kind: 'finding' }
  | { kind: 'trouble'; error: string }
  | { kind: 'choose'; companies: ServerCompany[] }
  | { kind: 'waiting'; request: WaitingRequest }
  | { kind: 'none' };

/**
 * Signed in, and not connected yet: the account's company, found among the ones it is on (my_companies)
 * and connected to. A crew sign-in names its company (`hint`); an email account on several is asked
 * which. On none: a request still waiting for a supervisor (my_join_requests) shows the waiting card, and
 * otherwise a crew account is off the roster and an email account has an invitation to accept first.
 * Asked again with Check again, and once signal comes back.
 */
function FindCompany({ account, hint, onDeleteAccount, onDeleteSignIn, onSignOut }: {
  account: ServerAccount;
  hint: { id: string; name: string } | null;
  onDeleteAccount: () => void;
  onDeleteSignIn: () => void;
  onSignOut: () => void;
}) {
  const asked = useStore((s) => (s.joinAsked?.accountId === account.id ? s.joinAsked : null));
  const connector = useConnectCompany({ id: account.id, email: account.email });
  const [found, setFound] = useState<Found>({ kind: 'finding' });
  const [busy, setBusy] = useState(true);
  const [tries, setTries] = useState(0);
  // The company a sign-in named is noted as its session is kept, so it can come a render after the
  // account does: it is read once the server has answered, as it is then.
  const named = useRef(hint);
  named.current = hint;

  // Signal back: asked again. Signal gone keeps what was found, which still stands.
  useEffect(
    () =>
      useSyncStatus.subscribe((now, before) => {
        if (now.online && !before.online) setTries((n) => n + 1);
      }),
    [],
  );

  useEffect(() => {
    if (!server) return undefined;
    const link = server;
    let live = true;
    const settle = (next: Found) => {
      setFound(next);
      setBusy(false);
    };
    setBusy(true);
    void (async () => {
      const mine = await link.myCompanies();
      if (!live) return;
      if (!mine.ok) return settle({ kind: 'trouble', error: mine.error });
      const hint = named.current;
      const company = hint ? pickCompany(mine.companies, { status: 'already_member', companyId: hint.id }) : mine.companies.length === 1 ? mine.companies[0] : null;
      if (company) {
        // Connected, the screen moves on to the company's records; asked first or turned back, the choice stays.
        if (!connector.connect(company)) settle({ kind: 'choose', companies: [company] });
        return;
      }
      if (mine.companies.length) return settle({ kind: 'choose', companies: mine.companies });
      const waiting = await link.myJoinRequests();
      if (!live) return;
      if (!waiting.ok) return settle({ kind: 'trouble', error: waiting.error });
      const request = waiting.requests.find((r) => !named.current || r.companyId === named.current.id);
      settle(request ? { kind: 'waiting', request } : { kind: 'none' });
    })();
    return () => {
      live = false;
    };
    // Asked again for another account, with Check again, and once signal comes back; the connector is the render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, tries]);

  const check = () => setTries((n) => n + 1);
  // As this sign-in, or the request this account made here, named it: never a guess from the phone's own.
  const companyName = hint?.name ?? asked?.companyName ?? null;
  let body: React.ReactNode;
  switch (found.kind) {
    case 'finding':
      body = <Waiting testID="company-finding" text="Finding your company…" />;
      break;
    case 'trouble':
      body = (
        <View testID="company-trouble" style={styles.gap}>
          <Notice tone="warn" icon={WifiOff} title="Could not find your company" body={found.error} />
          <Button testID="company-try-again" label="Try again" icon={RotateCcw} kind="outline" loading={busy} onPress={check} />
        </View>
      );
      break;
    case 'choose':
      body = (
        <View style={styles.gap}>
          <Txt v="lead">Which company is this phone for?</Txt>
          <CompanyChoice companies={found.companies} error={connector.error} onPick={(picked) => connector.connect(picked)} />
        </View>
      );
      break;
    case 'waiting': {
      const words = joinWords({ status: 'pending', companyName: companyName ?? undefined, reason: found.request.reason });
      body = (
        <View testID="company-waiting" style={styles.gap}>
          <Notice tone="info" icon={Clock} title={words.title} body={words.body} />
          <Button testID="company-check-again" label="Check again" icon={RotateCcw} loading={busy} onPress={check} />
        </View>
      );
      break;
    }
    case 'none':
      body =
        account.kind === 'email' ? (
          <View testID="company-no-company" style={styles.gap}>
            <Notice
              tone="info"
              icon={Building2}
              title="Accept your invitation first"
              body={`${account.email} is on no company’s roster yet. If a supervisor invited you, accept the invitation on the dashboard at app.minemuster.com, then tap Check again.`}
            />
            <Button testID="company-check-again" label="Check again" icon={RotateCcw} loading={busy} onPress={check} />
            <Button testID="company-delete-sign-in" label="Delete this sign-in" icon={UserX} kind="outline" onPress={onDeleteSignIn} />
          </View>
        ) : (
          <OffRoster company={companyName} onDelete={onDeleteAccount} />
        );
      break;
  }
  return (
    <View style={styles.gap}>
      {body}
      <SignOutOfPhone onPress={onSignOut} />
      {connector.ask}
    </View>
  );
}

/**
 * Connected to the company, and nobody's account open yet: the phone is getting the company's roster,
 * fleet, area sheets and settings, and the person's own account opens by itself once it has them. Or
 * why it cannot: the sign-in is off the roster, MineMuster stopped for the company, or the person is not
 * on the roster this phone got.
 */
function Opening({ account, linked, onDeleteAccount, onSignOut }: { account: ServerAccount; linked: ConnectedCompany; onDeleteAccount: () => void; onSignOut: () => void }) {
  const receiving = useStore((s) => (s.receiving?.company === linked.id ? s.receiving : null));
  const employees = useStore((s) => s.employees);
  const sync = useSyncStatus();
  const { notOnLinked, checking, unchecked } = useServerAccount();
  let body: React.ReactNode;
  if (linked.userId !== account.id) {
    // Another account than the one that connected: checked against the company's roster first (watchConnection).
    body = notOnLinked ? (
      <Notice
        tone="bo"
        icon={UserX}
        title={`This sign-in is not on ${linked.name}’s roster`}
        body={`This phone is connected to ${linked.name}. Sign out of this phone, then sign in as someone on its roster.`}
      />
    ) : unchecked && !checking ? (
      <View style={styles.gap}>
        <Notice tone="warn" icon={WifiOff} title={`Could not check your sign-in with ${linked.name}`} body="This needs signal. Nothing is lost meanwhile." />
        <Button testID="company-try-again" label="Try again" icon={RotateCcw} kind="outline" onPress={checkAccount} />
      </View>
    ) : (
      <Waiting text={`Checking your sign-in with ${linked.name}…`} />
    );
  } else if (receiving?.role === 'none') {
    body = <OffRoster company={linked.name} onDelete={onDeleteAccount} />;
  } else if (sync.trouble === 'closed') {
    body = <Notice tone="bo" title={`MineMuster has stopped for ${linked.name}`} body="A supervisor can start it again on the dashboard’s Billing page." />;
  } else if (receiving?.caughtUpAt != null && receiving.role != null) {
    const own = ownPersonHere(employees, receiving);
    const person = signInPerson(employees, receiving);
    body = own.ok ? (
      <Waiting text="Opening your account…" />
    ) : person.ok && !person.person.active ? (
      <OffRoster company={linked.name} onDelete={onDeleteAccount} />
    ) : (
      <View style={styles.gap}>
        <Notice tone="bo" title="Your account could not be opened" body={own.error} />
        <Button testID="company-check-again" label="Check again" icon={RotateCcw} kind="outline" onPress={() => void syncNow()} />
      </View>
    );
  } else if (!sync.online) {
    body = <Notice tone="warn" icon={WifiOff} title="No signal" body={`Your account opens by itself once this phone has signal and has got ${linked.name}’s roster.`} />;
  } else {
    body = <Waiting testID="company-opening" text={`Getting ${linked.name}’s roster, fleet and area sheets…`} />;
  }
  return (
    <View style={styles.gap}>
      {body}
      <SignOutOfPhone onPress={onSignOut} />
    </View>
  );
}

/** A sign-in whose roster row was taken off: it still works, only to delete the account. */
function OffRoster({ company, onDelete }: { company: string | null; onDelete: () => void }) {
  return (
    <View testID="company-off-roster" style={styles.gap}>
      <Notice
        tone="bo"
        icon={UserX}
        title={`You are no longer on ${company ? `${company}’s` : 'your company’s'} roster`}
        body={`Your sign-in still works, but only to delete your account. Your records stay with ${company ?? 'the company'}. If this is a mistake, see your supervisor.`}
      />
      <Button testID="company-delete-account" label="Delete my account" icon={UserX} kind="outline" onPress={onDelete} />
    </View>
  );
}

/** Sign out of this phone, on every card after a sign-in: the screen does it (signOutOfPhone). */
function SignOutOfPhone({ onPress }: { onPress: () => void }) {
  return <Button testID="company-sign-out" label="Sign out of this phone" icon={LogOut} kind="quiet" size="md" style={styles.tall} onPress={onPress} />;
}

const styles = StyleSheet.create({
  below: { marginTop: space.xl, marginHorizontal: space.lg },
  gap: { gap: space.lg },
  gapSmall: { gap: space.xs },
  // A quiet button is a full tap target for a gloved thumb.
  tall: { minHeight: TAP },
});
