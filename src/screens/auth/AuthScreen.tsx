import { Building2, Eye, EyeOff, HardHat, ShieldCheck, UserX } from '../../components/icons';
import { useNavigation } from '@react-navigation/native';
import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CompanyLogoPlate, MineMusterLogo, ProviderMark } from '../../components/Brand';
import { Button, Divider, Field, IconButton, Notice, Row, Segmented, Sheet, Txt } from '../../components/ui';
import { WebPageLinks } from '../../components/WebPageLinks';
import { AREA_SHEETS, DEMO_MODE, ROSTER, ROSTER_OWNER, SAMPLE_CREW, SERVER } from '../../config';
import { DELETED_TOAST, offRosterWords } from '../../domain/accountDeletion';
import { keepsTime } from '../../domain/company';
import { findOnRoster } from '../../domain/roster';
import { receiveWords } from '../../domain/sync';
import type { AuthProvider, Role } from '../../domain/types';
import { CAN_CONNECT, server } from '../../services/connection';
import { haptic } from '../../services/haptics';
import { useSyncStatus } from '../../services/sync';
import { useStore } from '../../store/useStore';
import { fmtTime } from '../../util/format';
import { color, font, radius, space } from '../../theme/theme';

type Mode = 'signin' | 'signup';
type Provider = Exclude<AuthProvider, 'password'>;

const PROVIDERS: { id: Provider; name: string }[] = [
  { id: 'apple', name: 'Apple' },
  { id: 'google', name: 'Google' },
  { id: 'microsoft', name: 'Microsoft' },
];

/**
 * Apple, Google and Microsoft are not connected yet: their buttons only ask for
 * a name. A build that sends to the company's server does not offer them, so
 * everyone there signs in with a password.
 */
const OFFER_PROVIDERS = !SERVER;

export function AuthScreen() {
  const insets = useSafeAreaInsets();
  const signIn = useStore((s) => s.signIn);
  const signUp = useStore((s) => s.signUp);
  const deleteAccountWithPassword = useStore((s) => s.deleteAccountWithPassword);
  const signInWithProvider = useStore((s) => s.signInWithProvider);
  const signInDemo = useStore((s) => s.signInDemo);
  const openAsOwner = useStore((s) => s.openAsOwner);
  const showToast = useStore((s) => s.showToast);
  const company = useStore((s) => s.settings.company);
  const place = company.place;
  const navigation = useNavigation();
  // A build that connects starts with nobody on its roster: the phone connects to its company first.
  const linked = useStore((s) => (CAN_CONNECT ? s.connectedCompany : null));
  const receiving = useStore((s) => (CAN_CONNECT ? s.receiving : null));
  const joinAsked = useStore((s) => (CAN_CONNECT ? s.joinAsked : null));
  const anyone = useStore((s) => s.employees.some((e) => e.active));
  const employees = useStore((s) => s.employees);
  const sync = useSyncStatus();
  const caughtUp = !!receiving?.caughtUpAt;
  // Only while the phone is joined: once its sign-in is gone, nothing here goes by that sign-in's name.
  const joinedAs = linked && caughtUp && receiving?.role !== 'none' ? receiving?.name ?? null : null;
  /** A phone joined with a crew sign-in holds that person's account only: the name is theirs. */
  const nameFixed = !!joinedAs && receiving?.role === 'employee';

  const [mode, setMode] = useState<Mode>('signin');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [companyPassword, setCompanyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Once the roster has come and nobody has an account here, the account is made first, under the sign-in's name.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!joinedAs || prefilled.current) return;
    prefilled.current = true;
    setMode('signup');
    setFirstName(joinedAs.firstName);
    setLastName(joinedAs.lastName);
  }, [joinedAs]);
  /** A supervisor's own account on a phone joined with their supervisor's sign-in needs that sign-in's password, checked once. */
  const typed = findOnRoster(employees.filter((e) => e.active), firstName, lastName);
  const typedPerson = typed && 'person' in typed ? typed.person : null;
  const needsCompanyPassword =
    mode === 'signup' &&
    !!linked?.email &&
    receiving?.role === 'supervisor' &&
    typedPerson?.role === 'supervisor' &&
    !!receiving.name &&
    !!findOnRoster([typedPerson], receiving.name.firstName, receiving.name.lastName);
  const [email, setEmailText] = useState('');
  const [password, setPasswordText] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The password was right, but the person is off the roster: they may delete the account from this phone.
  const [offRoster, setOffRoster] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);
  const setEmail = (text: string) => {
    setEmailText(text);
    setOffRoster(false);
  };
  const setPassword = (text: string) => {
    setPasswordText(text);
    setOffRoster(false);
  };
  // The hourly rate of the account typed, when one is on this phone.
  const typedHasRate = useStore((s) => {
    const typed = s.accounts.find((a) => a.email === email.trim().toLowerCase());
    return !!typed && s.payRates[typed.employeeId] != null;
  });
  const offRosterSheet = offRosterWords({
    email: email.trim().toLowerCase(),
    company: company.name || linked?.name || '',
    keepsTime: keepsTime(company),
    hasRate: typedHasRate,
  });

  const [provider, setProvider] = useState<Provider | null>(null);
  const [providerFirst, setProviderFirst] = useState('');
  const [providerLast, setProviderLast] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);

  const finish = (result: { ok: true; note?: string } | { ok: false; error: string }) => {
    if (result.ok) {
      haptic.success();
      if (mode === 'signup') showToast(result.note ?? 'Account created. You are signed in.', result.note ? 'warn' : 'ok');
    } else {
      haptic.error();
      // On a phone joined to a company, a new person is added in the office.
      const notFound = linked && /couldn't find/.test(result.error);
      setError(notFound ? `${result.error} If you are new, ask the office to add you on the dashboard’s Roster page. This phone gets it the next time it has signal.` : result.error);
    }
  };

  const submit = () => {
    if (mode === 'signin') {
      const result = signIn(email, password);
      setOffRoster(!result.ok && 'offRoster' in result);
      return finish(result);
    }
    if (!needsCompanyPassword) return finish(signUp({ firstName, lastName, email, password }));
    // The company sign-in's password is checked once with the server and dropped; it is never kept here.
    if (busyRef.current || !server || !linked?.email) return;
    if (!companyPassword) return setError(`Enter the password of this phone’s company sign-in, ${linked.email}.`);
    busyRef.current = true;
    setBusy(true);
    void server.checkPassword(linked.email, companyPassword).then((checked) => {
      busyRef.current = false;
      setBusy(false);
      setCompanyPassword('');
      if (!checked.ok) {
        haptic.error();
        setError(checked.error);
        return;
      }
      finish(signUp({ firstName, lastName, email, password, companyPasswordChecked: true }));
    });
  };

  const continueWithProvider = () => {
    if (!provider) return;
    const result = signInWithProvider(provider, providerFirst, providerLast);
    if (result.ok) {
      haptic.success();
      setProvider(null);
    } else {
      haptic.error();
      setProviderError(result.error);
    }
  };

  const demo = (role: Role) => {
    const result = signInDemo(role);
    if (!result.ok) showToast(result.error, 'bo');
  };

  const openOwner = () => {
    const result = openAsOwner();
    if (!result.ok) showToast(result.error, 'bo');
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        testID="auth-screen"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
      >
        <View style={[styles.field, { paddingTop: insets.top + space.xxl }]}>
          {company.logo ? <CompanyLogoPlate logo={company.logo} name={company.name} width={264} radius={10} /> : <MineMusterLogo width={280} />}
          <Txt v="h1" c={color.white} style={{ marginTop: space.xl }}>
            Clock in. Check your machine. Get paid right.
          </Txt>
          <Txt v="body" c={color.onDarkMuted} style={{ marginTop: space.sm }}>
            Time, checklists and maintenance requests for the crew{place ? ` at ${place}` : ''}.
          </Txt>
        </View>

        <View style={styles.form}>
          {CAN_CONNECT ? (
            <ConnectPanel
              linked={linked?.name ?? null}
              joinAsked={joinAsked?.companyName ?? (joinAsked ? 'your company' : null)}
              joinedAs={joinedAs}
              company={company.name || linked?.name || ''}
              anyone={anyone}
              second={
                linked
                  ? receiveWords(
                      {
                        connected: true,
                        online: sync.online,
                        role: receiving?.role ?? null,
                        caughtUpAt: receiving?.caughtUpAt ?? null,
                        closed: sync.trouble === 'closed',
                        unreadable: receiving?.unreadable.length ?? 0,
                        notTaken: 0,
                        company: linked.name,
                        email: linked.email ?? null,
                      },
                      fmtTime,
                    )
                  : null
              }
              onConnect={() => navigation.navigate('CompanyAccount')}
            />
          ) : null}
          {CAN_CONNECT && !anyone ? null : (
          <>
          <Segmented
            testID="auth-mode"
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

          {mode === 'signup' ? (
            <View style={styles.nameRow}>
              <View style={{ flex: 1 }}>
                <Field testID="first-name" label="First name" value={firstName} onChangeText={setFirstName} autoCapitalize="words" autoComplete="given-name" editable={!nameFixed} />
              </View>
              <View style={{ flex: 1 }}>
                <Field testID="last-name" label="Last name" value={lastName} onChangeText={setLastName} autoCapitalize="words" autoComplete="family-name" editable={!nameFixed} />
              </View>
            </View>
          ) : null}

          <Field
            testID="email"
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
          />
          <Field
            testID="password"
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            hint={mode === 'signup' ? (linked ? 'A password for MineMuster on this phone, at least 8 characters.' : 'At least 8 characters.') : undefined}
            onSubmitEditing={submit}
            right={
              <IconButton
                icon={showPassword ? EyeOff : Eye}
                label={showPassword ? 'Hide password' : 'Show password'}
                onPress={() => setShowPassword((v) => !v)}
                tint={color.silica}
              />
            }
          />

          {needsCompanyPassword && linked?.email ? (
            <Field
              testID="company-password"
              label={`Company sign-in password for ${linked.email}`}
              value={companyPassword}
              onChangeText={setCompanyPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="off"
              hint="Checked once with the company’s server to show this is you. It is not kept on this phone."
            />
          ) : null}

          {error ? (
            <View style={styles.error} accessibilityLiveRegion="polite">
              <Txt v="smallStrong" c={color.red} testID="auth-error">{error}</Txt>
            </View>
          ) : null}

          {offRoster && mode === 'signin' ? (
            <Button testID="auth-delete-account" label={offRosterSheet.button} icon={UserX} kind="outline" size="md" onPress={() => setAskingDelete(true)} />
          ) : null}

          <Button
            testID="auth-submit"
            label={mode === 'signin' ? 'Sign in' : 'Create account'}
            size="lg"
            kind="yellow"
            loading={busy}
            disabled={busy}
            onPress={submit}
          />

          {OFFER_PROVIDERS ? (
            <View style={styles.or}>
              <View style={styles.orLine} />
              <Txt v="small" c={color.silica}>or</Txt>
              <View style={styles.orLine} />
            </View>
          ) : null}

          {(OFFER_PROVIDERS ? PROVIDERS : []).map((p) => (
            <Pressable
              key={p.id}
              testID={`provider-${p.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Continue with ${p.name}`}
              onPress={() => {
                haptic.tap();
                setProviderError(null);
                setProvider(p.id);
              }}
              style={({ pressed }) => [styles.provider, p.id === 'apple' && styles.providerApple, pressed && { opacity: 0.75 }]}
            >
              <ProviderMark provider={p.id} />
              <Text style={[styles.providerText, p.id === 'apple' && { color: color.white }]}>Continue with {p.name}</Text>
            </Pressable>
          ))}

          <View style={styles.rosterNote}>
            <ShieldCheck color={color.green} size={22} />
            <Txt v="small" c={color.inkSoft} style={{ flex: 1 }}>
              Only people on the company’s roster can create an account. Use your name the way payroll has it.
            </Txt>
          </View>
          </>
          )}
        </View>

        {DEMO_MODE && SAMPLE_CREW ? (
          <View testID="preview-note" style={styles.demo}>
            <Txt v="h3">Look around first</Txt>
            <Txt v="small" c={color.silica}>
              {/* A build made with the mine's own roster or sheets holds those as well as the samples. */}
              {ROSTER.length > 0 || AREA_SHEETS.length > 0
                ? 'The hours, checklists and requests in this preview are samples that stay on this device. None of them is a real record.'
                : 'This preview runs on sample data that stays on this device. Nothing here is a real company’s record.'}
            </Txt>
            <View style={styles.demoRows}>
              <Row
                testID="demo-employee"
                left={<HardHat color={color.ink} size={26} />}
                title="Open as an employee"
                sub="Jordan Rivera, loader operator"
                chevron
                onPress={() => demo('employee')}
              />
              <Divider inset={space.lg} />
              <Row
                testID="demo-supervisor"
                left={<ShieldCheck color={color.ink} size={26} />}
                title="Open as a supervisor"
                sub="Casey Morgan, safety and operations"
                chevron
                onPress={() => demo('supervisor')}
              />
            </View>
          </View>
        ) : null}

        {/* A preview with nobody made up in it: there is no sample person to open it as, only the person it is made for. */}
        {DEMO_MODE && !SAMPLE_CREW ? (
          <View testID="preview-note" style={styles.demo}>
            <Txt v="h3">This is a preview</Txt>
            <Txt v="small" c={color.silica}>
              What you enter stays on this device. The equipment list is a made-up example until the mine's own is put in.
            </Txt>
            {ROSTER_OWNER ? (
              <View style={styles.demoRows}>
                <Row
                  testID="demo-owner"
                  left={<ShieldCheck color={color.ink} size={26} />}
                  title={`Open as ${ROSTER_OWNER.firstName} ${ROSTER_OWNER.lastName}`}
                  sub="Supervisor. Skips setting up an account, for showing the app."
                  chevron
                  onPress={openOwner}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.pages}>
          <WebPageLinks testID="auth-pages" />
        </View>
      </ScrollView>

      <Sheet
        testID="provider-sheet"
        visible={provider != null}
        onClose={() => setProvider(null)}
        title={`Continue with ${PROVIDERS.find((p) => p.id === provider)?.name ?? ''}`}
      >
        <Txt v="body" c={color.inkSoft}>
          {DEMO_MODE
            ? 'This preview is not connected to the sign-in provider yet, so no outside account is opened. Enter your name as it is on the roster to carry on.'
            : 'Enter your name as it is on the roster so we can match your account.'}
        </Txt>
        <Field testID="provider-first" label="First name" value={providerFirst} onChangeText={setProviderFirst} autoCapitalize="words" />
        <Field testID="provider-last" label="Last name" value={providerLast} onChangeText={setProviderLast} autoCapitalize="words" />
        {providerError ? <Txt v="smallStrong" c={color.red}>{providerError}</Txt> : null}
        <Button testID="provider-continue" label="Continue" kind="ink" onPress={continueWithProvider} />
      </Sheet>

      <Sheet testID="auth-delete-sheet" visible={askingDelete} onClose={() => setAskingDelete(false)} title={offRosterSheet.title}>
        <Txt v="body" c={color.inkSoft}>{offRosterSheet.body}</Txt>
        <Txt v="small" c={color.silica} testID="auth-delete-legal">{offRosterSheet.legal}</Txt>
        <Button
          testID="auth-delete-confirm"
          label={offRosterSheet.confirm}
          kind="red"
          onPress={() => {
            setAskingDelete(false);
            const result = deleteAccountWithPassword(email, password);
            if (!result.ok) {
              haptic.error();
              setError(result.error);
              return;
            }
            haptic.success();
            setOffRoster(false);
            setError(null);
            setEmailText('');
            setPasswordText('');
            showToast(DELETED_TOAST);
          }}
        />
        <Button testID="auth-delete-keep" label={offRosterSheet.keep} kind="outline" onPress={() => setAskingDelete(false)} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  field: { backgroundColor: color.ink, paddingHorizontal: space.xl, paddingBottom: 64 },
  form: {
    marginTop: -40,
    marginHorizontal: space.lg,
    padding: space.xl,
    gap: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.rule,
  },
  nameRow: { flexDirection: 'row', gap: space.md },
  error: { backgroundColor: color.redTint, borderRadius: radius.md, padding: space.md, borderLeftWidth: 6, borderLeftColor: color.red },
  or: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  orLine: { flex: 1, height: 1, backgroundColor: color.rule },
  provider: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.silicaLight,
    backgroundColor: color.paper,
  },
  providerApple: { backgroundColor: '#000000', borderColor: '#000000' },
  providerText: { fontFamily: font.bodySemi, fontSize: 18, color: color.ink },
  rosterNote: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  demo: { marginTop: space.xxl, marginHorizontal: space.lg, gap: space.sm },
  pages: { marginTop: space.xxl, marginHorizontal: space.lg },
  demoRows: {
    marginTop: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
    overflow: 'hidden',
  },
});

/**
 * In a build that connects: the way to connect a new phone to its company, and
 * then where the company's roster stands, before anyone makes an account.
 */
function ConnectPanel({ linked, joinAsked, joinedAs, company, anyone, second, onConnect }: {
  linked: string | null;
  joinAsked: string | null;
  joinedAs: { firstName: string; lastName: string } | null;
  company: string;
  anyone: boolean;
  second: { line: string; warn: boolean } | null;
  onConnect: () => void;
}) {
  if (!linked) {
    return (
      <View style={{ gap: space.md }} testID="auth-connect">
        <Notice
          tone="info"
          icon={Building2}
          title="New phone?"
          body="Connect this phone to your company first, so it has the company’s roster. Then make your account under your own name."
        />
        {joinAsked ? (
          <Notice tone="warn" title={`Your request to join ${joinAsked} waits for a supervisor.`} body="Check on it under Connect to your company." />
        ) : null}
        <Button testID="auth-connect-button" label="Connect to your company" icon={Building2} kind={anyone ? 'outline' : 'yellow'} onPress={onConnect} />
        {anyone ? null : <Txt v="small" c={color.inkSoft}>Once this phone has your company’s roster, you make your account here.</Txt>}
      </View>
    );
  }
  if (second?.warn) return <Notice tone="bo" title={second.line} />;
  if (!anyone) {
    const getting = second && !/last came/.test(second.line);
    return (
      <View testID="auth-getting">
        <Notice
          tone="info"
          title={getting ? 'Getting your company’s roster, fleet and area sheets.' : 'Nothing came from the company.'}
          body={getting ? (second?.line.startsWith('No signal') ? second.line : undefined) : 'Ask the office to check the company’s roster on the dashboard.'}
        />
      </View>
    );
  }
  if (!joinedAs) return null;
  return (
    <View testID="auth-joined-as">
      <Notice
        tone="ok"
        title={`${company}’s roster is on this phone. You joined as ${joinedAs.firstName} ${joinedAs.lastName}.`}
        body="If that is not you, tell your supervisor now. Make your account under your own name."
      />
    </View>
  );
}
