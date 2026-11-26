import { Eye, EyeOff, HardHat, ShieldCheck, UserX } from '../../components/icons';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProviderMark } from '../../components/Brand';
import { SignInHeader, signInStyles } from '../../components/SignInHeader';
import { Button, Divider, Field, IconButton, Row, Segmented, Sheet, Txt } from '../../components/ui';
import { WebPageLinks } from '../../components/WebPageLinks';
import { AREA_SHEETS, DEMO_MODE, ROSTER, ROSTER_OWNER, SAMPLE_CREW, SERVER } from '../../config';
import { DELETED_TOAST, offRosterWords } from '../../domain/accountDeletion';
import { keepsTime } from '../../domain/company';
import type { AuthProvider, Role } from '../../domain/types';
import { haptic } from '../../services/haptics';
import { useStore } from '../../store/useStore';
import { color, font, radius, space } from '../../theme/theme';

type Mode = 'signin' | 'signup';
type Provider = Exclude<AuthProvider, 'password' | 'company'>;

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

/**
 * Signing in with an account kept on this phone, in a build that sends to no
 * company server: a preview, or one that holds the made-up sample crew. A
 * build that connects signs in to the company instead (CompanySignInScreen).
 */
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

  const [mode, setMode] = useState<Mode>('signin');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
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
    company: company.name,
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
      setError(result.error);
    }
  };

  const submit = () => {
    if (mode === 'signin') {
      const result = signIn(email, password);
      setOffRoster(!result.ok && 'offRoster' in result);
      return finish(result);
    }
    finish(signUp({ firstName, lastName, email, password }));
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
    <KeyboardAvoidingView style={signInStyles.root} behavior="padding">
      <ScrollView
        testID="auth-screen"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
      >
        {/* The phone's own company, the build's or the one a supervisor set, is known from the start. */}
        <SignInHeader company={company} />

        <View style={signInStyles.card}>
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
                <Field testID="first-name" label="First name" value={firstName} onChangeText={setFirstName} autoCapitalize="words" autoComplete="given-name" />
              </View>
              <View style={{ flex: 1 }}>
                <Field testID="last-name" label="Last name" value={lastName} onChangeText={setLastName} autoCapitalize="words" autoComplete="family-name" />
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
            hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
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

          {error ? (
            <View style={styles.error} accessibilityLiveRegion="polite">
              <Txt v="smallStrong" c={color.red} testID="auth-error">{error}</Txt>
            </View>
          ) : null}

          {offRoster && mode === 'signin' ? (
            <Button testID="auth-delete-account" label={offRosterSheet.button} icon={UserX} kind="outline" size="md" onPress={() => setAskingDelete(true)} />
          ) : null}

          <Button testID="auth-submit" label={mode === 'signin' ? 'Sign in' : 'Create account'} size="lg" kind="yellow" onPress={submit} />

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

