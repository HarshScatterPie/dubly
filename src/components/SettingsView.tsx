import React, { useEffect, useState } from 'react';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import {
  Bell,
  BookA,
  Check,
  KeyRound,
  Languages,
  Loader2,
  LogOut,
  Mic,
  Play,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  UserRound,
  Users,
  BarChart3,
  Clapperboard,
} from 'lucide-react';
import type { NavigationTab, TranslationStyle, UserPreferences, UserUsageStats, Voice, VoiceEmotion } from '../types';
import { LANGUAGES, VOICES } from '../data/mockData';
import { DEFAULT_PREFERENCES } from '../data/preferences';
import { useAuth } from '../context/AuthContext';
import { settingsService } from '../services/settingsService';
import { voiceCloneService } from '../services/voiceCloneService';
import { textToSpeechService } from '../services/textToSpeechService';
import type { WorkspaceInfo } from '../services/workspaceService';
import { apiGet } from '../lib/apiClient';
import { loadDevicePrefs, notificationsSupported, notifyWorkDone, saveDevicePrefs, type DevicePrefs } from '../lib/devicePrefs';
import { ConfirmDialog } from './ConfirmDialog';

interface SettingsViewProps {
  preferences: UserPreferences | null;
  onPreferencesSaved: (preferences: UserPreferences) => void;
  workspace: WorkspaceInfo | null;
  usage: UserUsageStats;
  onNavigate: (tab: NavigationTab) => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

const SECTIONS = [
  { id: 'account', label: 'Account & security', Icon: UserRound },
  { id: 'dubbing', label: 'Dubbing defaults', Icon: Languages },
  { id: 'voice', label: 'Voice', Icon: Mic },
  { id: 'render', label: 'Rendering & export', Icon: Clapperboard },
  { id: 'notifications', label: 'Notifications', Icon: Bell },
  { id: 'workspace', label: 'Workspace', Icon: Users },
] as const;

const STYLES: { id: TranslationStyle; label: string; desc: string }[] = [
  { id: 'natural', label: 'Natural', desc: 'Idiomatic, native phrasing' },
  { id: 'literal', label: 'Literal', desc: 'Close to the original words' },
  { id: 'professional', label: 'Professional', desc: 'Formal business tone' },
  { id: 'casual', label: 'Casual', desc: 'Relaxed creator tone' },
  { id: 'marketing', label: 'Marketing', desc: 'Punchy and persuasive' },
];

const EMOTIONS: { id: VoiceEmotion; label: string; icon: string }[] = [
  { id: 'neutral', label: 'Neutral', icon: '🎯' },
  { id: 'friendly', label: 'Friendly', icon: '😊' },
  { id: 'energetic', label: 'Energetic', icon: '⚡' },
  { id: 'professional', label: 'Professional', icon: '👔' },
  { id: 'empathetic', label: 'Empathetic', icon: '🤝' },
];

const MAX_DEFAULT_LANGUAGES = 10;

const inputClass =
  'w-full px-3 py-2.5 rounded-xl bg-white border border-[#E2E8F0] text-sm text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#F05637]/25 focus:border-[#F05637]/60';

const Toggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string }> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative w-10 h-6 rounded-full transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F05637]/40 disabled:opacity-40 disabled:cursor-not-allowed ${checked ? 'bg-[#F05637]' : 'bg-[#CBD5E1]'}`}
  >
    {/* Anchored at the left: inside a button an unanchored absolute child starts from the centre, which pushed the knob off the track. */}
    <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
  </button>
);

const Section: React.FC<{ id: string; title: string; subtitle: string; Icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; action?: React.ReactNode }> = ({
  id,
  title,
  subtitle,
  Icon,
  children,
  action,
}) => (
  <section id={`settings-${id}`} className="rounded-3xl glass-panel overflow-hidden scroll-mt-24">
    <div className="flex items-start justify-between gap-3 px-5 sm:px-6 py-4 border-b border-[#E2E8F0]">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#F05637]/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-[#F05637]" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-[#0F172A]">{title}</h3>
          <p className="text-xs text-[#64748B] mt-0.5">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
    <div className="divide-y divide-[#E2E8F0]">{children}</div>
  </section>
);

const Row: React.FC<{ title: string; hint?: React.ReactNode; children: React.ReactNode; stacked?: boolean }> = ({ title, hint, children, stacked }) => (
  <div className={`px-5 sm:px-6 py-4 ${stacked ? 'space-y-3' : 'flex items-center justify-between gap-4'}`}>
    <div className="min-w-0">
      <span className="text-sm font-semibold text-[#0F172A] block">{title}</span>
      {hint && <span className="text-xs text-[#64748B] block mt-0.5">{hint}</span>}
    </div>
    {children}
  </div>
);

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

// Everything a user can change about how Dubly works for them: account security, the defaults every new dub starts from, and this device's alerts.
export const SettingsView: React.FC<SettingsViewProps> = ({ preferences, onPreferencesSaved, workspace, usage, onNavigate, onShowToast }) => {
  const { user, profile, signOut } = useAuth();
  const [draft, setDraft] = useState<UserPreferences>(preferences ?? DEFAULT_PREFERENCES);
  const [saving, setSaving] = useState(false);
  const [customVoices, setCustomVoices] = useState<Voice[]>([]);
  const [engines, setEngines] = useState<{ lipSyncAvailable: boolean; separationAvailable: boolean } | null>(null);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePrefs>(loadDevicePrefs);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(notificationsSupported() ? Notification.permission : 'unsupported');
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' });
  const [changingPassword, setChangingPassword] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  // The saved copy can arrive after the page opens; it only replaces the form while nothing has been edited.
  useEffect(() => {
    if (preferences) setDraft((current) => (JSON.stringify(current) === JSON.stringify(DEFAULT_PREFERENCES) ? preferences : current));
  }, [preferences]);

  useEffect(() => {
    voiceCloneService
      .list()
      .then((res) => setCustomVoices(res.voices.map((v) => voiceCloneService.toVoice(v))))
      .catch(() => setCustomVoices([]));
    apiGet<{ lipSyncAvailable: boolean; separationAvailable: boolean }>('/api/health')
      .then(setEngines)
      .catch(() => setEngines({ lipSyncAvailable: false, separationAvailable: false }));
  }, []);

  const saved = preferences ?? DEFAULT_PREFERENCES;
  const isDirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const update = (patch: Partial<UserPreferences>) => setDraft((prev) => ({ ...prev, ...patch }));
  const allVoices = [...customVoices, ...VOICES];
  const hasPassword = Boolean(user?.providerData.some((p) => p.providerId === 'password'));
  const signInMethod = hasPassword ? 'Email and password' : user?.providerData.some((p) => p.providerId === 'google.com') ? 'Google' : 'Single sign-on';
  const displayName = profile?.name || user?.displayName || user?.email?.split('@')[0] || 'You';
  const minutesPercent = usage.minutesLimit > 0 ? Math.min(100, (usage.minutesDubbed / usage.minutesLimit) * 100) : 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await settingsService.savePreferences(draft);
      onPreferencesSaved(result);
      setDraft(result);
      onShowToast('Settings Saved', 'New dubs start from these defaults, on every device you use.', 'success');
    } catch (err) {
      onShowToast('Could Not Save Settings', (err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleLanguage = (code: string) => {
    const has = draft.defaultTargetLanguages.includes(code);
    if (!has && draft.defaultTargetLanguages.length >= MAX_DEFAULT_LANGUAGES) {
      onShowToast('Language Limit', `A dub can target up to ${MAX_DEFAULT_LANGUAGES} languages.`, 'info');
      return;
    }
    update({ defaultTargetLanguages: has ? draft.defaultTargetLanguages.filter((c) => c !== code) : [...draft.defaultTargetLanguages, code] });
  };

  const previewVoice = async (voice: Voice) => {
    if (previewingVoiceId === voice.id) {
      textToSpeechService.stopPlayback();
      setPreviewingVoiceId(null);
      return;
    }
    setPreviewingVoiceId(voice.id);
    await textToSpeechService.speakText(voice.sampleQuote, voice, voice.languageCode, {
      emotion: draft.voiceEmotion,
      onEnd: () => setPreviewingVoiceId((cur) => (cur === voice.id ? null : cur)),
      onError: (err) => {
        setPreviewingVoiceId(null);
        onShowToast('Preview Failed', err.message, 'error');
      },
    });
  };

  const updateDevice = (patch: Partial<DevicePrefs>) => {
    const next = { ...device, ...patch };
    setDevice(next);
    saveDevicePrefs(next);
  };

  const handleDesktopNotifications = async (enabled: boolean) => {
    if (!enabled) {
      updateDevice({ desktopNotifications: false });
      return;
    }
    if (!notificationsSupported()) return;
    const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    setPermission(result);
    if (result === 'granted') updateDevice({ desktopNotifications: true });
    else onShowToast('Notifications Blocked', 'Allow notifications for this site in your browser settings, then turn this on again.', 'error');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.email) return;
    if (password.next.length < 8) {
      onShowToast('Password Too Short', 'Use at least 8 characters.', 'error');
      return;
    }
    if (password.next !== password.confirm) {
      onShowToast('Passwords Do Not Match', 'Type the new password the same way twice.', 'error');
      return;
    }
    setChangingPassword(true);
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password.current));
      await updatePassword(user, password.next);
      setPassword({ current: '', next: '', confirm: '' });
      onShowToast('Password Changed', 'Use the new password next time you sign in to Dubly or ScatterStudio.', 'success');
    } catch (err) {
      const code = (err as { code?: string }).code || '';
      const message = /wrong-password|invalid-credential/.test(code)
        ? 'Your current password is not right.'
        : /too-many-requests/.test(code)
          ? 'Too many attempts. Wait a few minutes and try again.'
          : /weak-password/.test(code)
            ? 'Choose a stronger password.'
            : (err as Error).message;
      onShowToast('Could Not Change Password', message, 'error');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleSignOutEverywhere = async () => {
    setConfirmSignOutAll(false);
    try {
      await settingsService.signOutEverywhere();
      onShowToast('Signed Out Everywhere', 'Every session of your account has ended, including this one.', 'success');
    } catch (err) {
      onShowToast('Could Not Sign Out Everywhere', (err as Error).message, 'error');
      return;
    }
    await signOut();
  };

  const jumpTo = (id: string) => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-fade-in">
      <div className="mb-6">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8]">Settings</span>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">Make Dubly work your way</h2>
        <p className="text-sm text-[#64748B] mt-1">Defaults are saved to your account and apply on every device. Notifications are set per device.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 items-start">
        <nav className="hidden lg:block sticky top-24 space-y-1" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => jumpTo(id)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="space-y-6 pb-24">
          {/* Account & security */}
          <Section id="account" title="Account & security" subtitle="Your ScatterStudio account, as Dubly sees it" Icon={UserRound}>
            <div className="px-5 sm:px-6 py-5 flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-[#F05637] text-white flex items-center justify-center text-lg font-bold shrink-0">{initials(displayName)}</div>
              <div className="min-w-0">
                <p className="text-base font-bold text-[#0F172A] truncate">{displayName}</p>
                <p className="text-sm text-[#64748B] truncate">{user?.email}</p>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Signed in with {signInMethod}
                  {workspace ? ` · ${workspace.myRole === 'admin' ? 'Admin' : 'Editor'} of ${workspace.name}` : ''}
                </p>
              </div>
            </div>
            <Row title="Name and profile" hint="Your name comes from your ScatterStudio profile, so it is changed there and shows up everywhere.">
              <span className="text-xs font-semibold text-[#64748B] px-2.5 py-1 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] shrink-0">Managed in ScatterStudio</span>
            </Row>

            {hasPassword && (
              <form onSubmit={handleChangePassword} className="px-5 sm:px-6 py-4 space-y-3">
                <div>
                  <span className="text-sm font-semibold text-[#0F172A] flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-[#64748B]" /> Change password
                  </span>
                  <span className="text-xs text-[#64748B] block mt-0.5">This is also your ScatterStudio password.</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input type="password" autoComplete="current-password" placeholder="Current password" value={password.current} onChange={(e) => setPassword({ ...password, current: e.target.value })} className={inputClass} aria-label="Current password" />
                  <input type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={password.next} onChange={(e) => setPassword({ ...password, next: e.target.value })} className={inputClass} aria-label="New password" />
                  <input type="password" autoComplete="new-password" placeholder="Repeat new password" value={password.confirm} onChange={(e) => setPassword({ ...password, confirm: e.target.value })} className={inputClass} aria-label="Repeat new password" />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={changingPassword || !password.current || !password.next}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0F172A] text-white text-xs font-semibold disabled:opacity-40"
                  >
                    {changingPassword ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Update password
                  </button>
                </div>
              </form>
            )}

            <Row title="Sign out of this device" hint="You stay signed in on your other devices.">
              <button type="button" onClick={() => void signOut()} className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] shrink-0">
                <LogOut className="w-3.5 h-3.5" /> Sign out
              </button>
            </Row>
            <Row title="Sign out everywhere" hint="Ends every session of your account, on every device, including this one. Use it if you signed in on a shared computer.">
              <button type="button" onClick={() => setConfirmSignOutAll(true)} className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 shrink-0">
                <ShieldCheck className="w-3.5 h-3.5" /> Sign out everywhere
              </button>
            </Row>
          </Section>

          {/* Dubbing defaults */}
          <Section
            id="dubbing"
            title="Dubbing defaults"
            subtitle="What every new dub starts with; you can still change anything in the studio"
            Icon={Languages}
            action={
              <button type="button" onClick={() => setDraft({ ...DEFAULT_PREFERENCES })} className="flex items-center gap-1.5 text-xs font-semibold text-[#64748B] hover:text-[#0F172A] shrink-0">
                <RotateCcw className="w-3.5 h-3.5" /> Reset all
              </button>
            }
          >
            <Row stacked title="Languages to pre-select" hint={draft.defaultTargetLanguages.length ? `${draft.defaultTargetLanguages.length} selected. New dubs start with these ticked.` : 'None: you pick the languages for each dub.'}>
              <div className="flex flex-wrap gap-1.5">
                {LANGUAGES.map((lang) => {
                  const selected = draft.defaultTargetLanguages.includes(lang.code);
                  return (
                    <button
                      key={lang.code}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleLanguage(lang.code)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                        selected ? 'bg-[#F05637] border-[#F05637] text-white' : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]'
                      }`}
                    >
                      {lang.flag} {lang.name}
                    </button>
                  );
                })}
              </div>
            </Row>
            <Row stacked title="Translation style">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    onClick={() => update({ translationStyle: style.id })}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      draft.translationStyle === style.id ? 'bg-[#F05637]/10 border-[#F05637] text-[#0F172A]' : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]'
                    }`}
                  >
                    <span className="text-xs font-bold block">{style.label}</span>
                    <span className="text-[10px] text-[#94A3B8] block mt-0.5">{style.desc}</span>
                  </button>
                ))}
              </div>
            </Row>
            <Row title="Adapt idioms for native speakers" hint="Translates expressions and cultural references naturally instead of word for word.">
              <Toggle label="Adapt idioms" checked={draft.adaptExpressions} onChange={(v) => update({ adaptExpressions: v })} />
            </Row>
          </Section>

          {/* Voice */}
          <Section id="voice" title="Voice" subtitle="The voice and performance new dubs start with" Icon={Mic}>
            <Row stacked title="Default voice" hint="Used for every language until you pick another in the studio. Your cloned voices are listed first.">
              <div className="flex gap-2">
                <select value={draft.defaultVoiceId} onChange={(e) => update({ defaultVoiceId: e.target.value })} className={inputClass} aria-label="Default voice">
                  {customVoices.length > 0 && (
                    <optgroup label="My voices">
                      {customVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Dubly voices">
                    {VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · {v.accent} · {v.gender}
                      </option>
                    ))}
                  </optgroup>
                </select>
                {(() => {
                  const voice = allVoices.find((v) => v.id === draft.defaultVoiceId);
                  if (!voice) return null;
                  const playing = previewingVoiceId === voice.id;
                  return (
                    <button
                      type="button"
                      onClick={() => void previewVoice(voice)}
                      className="flex items-center gap-1.5 px-3.5 rounded-xl border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] shrink-0"
                    >
                      {playing ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      {playing ? 'Stop' : 'Listen'}
                    </button>
                  );
                })()}
              </div>
            </Row>
            <Row stacked title="Emotion" hint="The overall tone. Each line still keeps the delivery heard in the original.">
              <div className="flex flex-wrap gap-1.5">
                {EMOTIONS.map((emo) => (
                  <button
                    key={emo.id}
                    type="button"
                    onClick={() => update({ voiceEmotion: emo.id })}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      draft.voiceEmotion === emo.id ? 'bg-[#F05637] border-[#F05637] text-white' : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]'
                    }`}
                  >
                    <span>{emo.icon}</span>
                    {emo.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row stacked title="Speaking speed" hint="Lines still speed up on their own when they must fit a short slot.">
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-[#94A3B8] w-12">Slower</span>
                <input
                  type="range"
                  min={0.8}
                  max={1.2}
                  step={0.05}
                  value={draft.voiceSpeed}
                  onChange={(e) => update({ voiceSpeed: Number(e.target.value) })}
                  className="flex-1 accent-[#F05637]"
                  aria-label="Speaking speed"
                />
                <span className="text-[11px] text-[#94A3B8] w-12 text-right">Faster</span>
                <span className="text-xs font-bold text-[#0F172A] w-12 text-right">{draft.voiceSpeed.toFixed(2)}×</span>
              </div>
            </Row>
            <Row title="Expressive voices" hint="Voices follow the emotion and each line's delivery. Turn off for steadier, more uniform narration.">
              <Toggle label="Expressive voices" checked={draft.expressiveVoices} onChange={(v) => update({ expressiveVoices: v })} />
            </Row>
          </Section>

          {/* Rendering & export */}
          <Section id="render" title="Rendering & export" subtitle="Extra processing and how downloads start out" Icon={Clapperboard}>
            <Row
              title="Keep background music under the voice"
              hint={engines && !engines.separationAvailable ? 'Not available on this server yet: music plays between lines instead.' : 'Separates music and ambience so they keep playing under the dub. Adds a few minutes per video.'}
            >
              <Toggle label="Keep background music" checked={draft.separateBackground} disabled={engines !== null && !engines.separationAvailable} onChange={(v) => update({ separateBackground: v })} />
            </Row>
            <Row title="Lip-sync" hint={engines && !engines.lipSyncAvailable ? 'Not available on this server yet.' : 'Matches mouth movements to the new language. Slow, and best on clear, front-facing faces.'}>
              <Toggle label="Lip-sync" checked={draft.autoLipSync} disabled={engines !== null && !engines.lipSyncAvailable} onChange={(v) => update({ autoLipSync: v })} />
            </Row>
            <Row title="Burn captions into downloads" hint="Downloads start with word-by-word captions on the video. You can still switch it per download.">
              <Toggle label="Burn captions" checked={draft.burnCaptions} onChange={(v) => update({ burnCaptions: v })} />
            </Row>
          </Section>

          {/* Notifications */}
          <Section id="notifications" title="Notifications" subtitle="How this device tells you a long job is done" Icon={Bell}>
            <Row
              title="Desktop notification"
              hint={
                permission === 'unsupported'
                  ? 'This browser does not support notifications.'
                  : permission === 'denied'
                    ? 'Blocked in your browser. Allow notifications for this site to turn it on.'
                    : 'When analysis or a dub finishes while you are in another tab or app.'
              }
            >
              <Toggle label="Desktop notification" checked={device.desktopNotifications && permission === 'granted'} disabled={permission === 'unsupported' || permission === 'denied'} onChange={(v) => void handleDesktopNotifications(v)} />
            </Row>
            <Row title="Play a sound" hint="A short chime when a job finishes.">
              <Toggle label="Play a sound" checked={device.completionSound} onChange={(v) => updateDevice({ completionSound: v })} />
            </Row>
            <Row title="Celebrate finished dubs" hint="A burst of confetti on the export screen.">
              <Toggle label="Celebrate" checked={device.celebrate} onChange={(v) => updateDevice({ celebrate: v })} />
            </Row>
            <Row title="Try it" hint="Plays the chime and, if allowed, shows a notification.">
              <button type="button" onClick={() => notifyWorkDone('Dubly', 'This is how you will know a dub is ready.', { force: true })} className="px-3.5 py-2 rounded-xl border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] shrink-0">
                Send a test
              </button>
            </Row>
          </Section>

          {/* Workspace */}
          <Section id="workspace" title="Workspace" subtitle={workspace ? `${workspace.name} · ${workspace.members.length} member${workspace.members.length === 1 ? '' : 's'}` : 'Your team'} Icon={Users}>
            <div className="px-5 sm:px-6 py-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#0F172A]">Minutes this month</span>
                <span className="text-[#64748B]">
                  {usage.minutesDubbed.toFixed(1)} of {usage.minutesLimit} min
                </span>
              </div>
              <div className="h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
                <div className={`h-full ${minutesPercent > 90 ? 'bg-rose-500' : 'bg-[#F05637]'}`} style={{ width: `${minutesPercent}%` }} />
              </div>
              <p className="text-[11px] text-[#94A3B8]">Shared by everyone in the workspace.</p>
            </div>
            <div className="px-5 sm:px-6 py-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { tab: 'team' as NavigationTab, label: 'Team', Icon: Users },
                { tab: 'glossary' as NavigationTab, label: 'Glossary', Icon: BookA },
                { tab: 'my-voices' as NavigationTab, label: 'My voices', Icon: Mic },
                { tab: 'usage' as NavigationTab, label: 'Usage', Icon: BarChart3 },
              ].map(({ tab, label, Icon }) => (
                <button key={tab} type="button" onClick={() => onNavigate(tab)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">
                  <Icon className="w-4 h-4 text-[#F05637]" />
                  {label}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {isDirty && (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-3 rounded-2xl bg-[#0F172A] text-white shadow-2xl animate-fade-in">
          <Settings2 className="w-4 h-4 text-[#F05637]" />
          <span className="text-xs font-semibold">You have unsaved changes</span>
          <button type="button" onClick={() => setDraft(saved)} className="text-xs font-semibold text-slate-300 hover:text-white px-2">
            Discard
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-xs font-semibold disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save
          </button>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmSignOutAll}
        title="Sign out everywhere?"
        description="Every session of your account ends, on every device, including this one. You will need to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={() => void handleSignOutEverywhere()}
        onCancel={() => setConfirmSignOutAll(false)}
      />
    </div>
  );
};
