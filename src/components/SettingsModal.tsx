/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { X, Check, LogOut } from 'lucide-react';
import { LANGUAGES, VOICES } from '../data/mockData';
import { useAuth } from '../context/AuthContext';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

const PREFS_STORAGE_KEY = 'dubly:dubbing-preferences';

interface DubbingPreferences {
  defaultTargetLang: string;
  defaultVoice: string;
  defaultStyle: string;
  adaptExpressions: boolean;
}

export function loadDubbingPreferences(): DubbingPreferences | null {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DubbingPreferences) : null;
  } catch {
    return null;
  }
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onShowToast,
}) => {
  const { user, profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<'preferences' | 'profile'>('preferences');
  const [defaultTargetLang, setDefaultTargetLang] = useState('hi');
  const [defaultVoice, setDefaultVoice] = useState('riya');
  const [defaultStyle, setDefaultStyle] = useState('natural');
  const [adaptExpressions, setAdaptExpressions] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const saved = loadDubbingPreferences();
    if (saved) {
      setDefaultTargetLang(saved.defaultTargetLang);
      setDefaultVoice(saved.defaultVoice);
      setDefaultStyle(saved.defaultStyle);
      setAdaptExpressions(saved.adaptExpressions);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      localStorage.setItem(
        PREFS_STORAGE_KEY,
        JSON.stringify({ defaultTargetLang, defaultVoice, defaultStyle, adaptExpressions })
      );
      onShowToast('Settings Saved', 'Studio configuration updated.', 'success');
      onClose();
    } catch (err) {
      onShowToast('Save Failed', (err as Error).message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="glass-panel rounded-3xl max-w-2xl w-full overflow-hidden shadow-2xl animate-fade-in flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-6 border-b border-[#E2E8F0] flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-[#0F172A] tracking-tight">Studio Settings</h3>
            <p className="text-xs text-[#64748B]">
              Set your default dubbing language, voice, and translation style
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Strip */}
        <div className="flex border-b border-[#E2E8F0] px-6 bg-[#FFFFFF]/50 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('preferences')}
            className={`py-3 px-4 font-semibold border-b-2 transition-colors ${
              activeTab === 'preferences'
                ? 'border-[#F05637] text-[#0F172A]'
                : 'border-transparent text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            Dubbing Preferences
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`py-3 px-4 font-semibold border-b-2 transition-colors ${
              activeTab === 'profile'
                ? 'border-[#F05637] text-[#0F172A]'
                : 'border-transparent text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            Profile & Workspace
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1 text-xs">
          {activeTab === 'preferences' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[#64748B] font-bold block">
                  Default Target Language
                </label>
                <select
                  value={defaultTargetLang}
                  onChange={(e) => setDefaultTargetLang(e.target.value)}
                  className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.flag} {l.name} ({l.nativeName})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[#64748B] font-bold block">
                  Default Voice Model
                </label>
                <select
                  value={defaultVoice}
                  onChange={(e) => setDefaultVoice(e.target.value)}
                  className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                >
                  {VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.accent} · {v.gender})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[#64748B] font-bold block">
                  Translation Tone Default
                </label>
                <select
                  value={defaultStyle}
                  onChange={(e) => setDefaultStyle(e.target.value)}
                  className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none focus:border-[#F05637]"
                >
                  <option value="natural">Natural (Native Idiomatic Phrasing)</option>
                  <option value="literal">Literal (Word-for-word)</option>
                  <option value="professional">Professional (Business & Keynotes)</option>
                  <option value="casual">Casual (Social Media & Creators)</option>
                  <option value="marketing">Marketing (High Energy & Impact)</option>
                </select>
              </div>

              <div className="flex items-center justify-between p-3.5 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                <div>
                  <span className="font-bold text-[#0F172A] block">
                    Adapt Expressions for Native Speakers
                  </span>
                  <span className="text-[11px] text-[#94A3B8]">
                    Automatically localizes cultural idioms during translation
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={adaptExpressions}
                  onChange={(e) => setAdaptExpressions(e.target.checked)}
                  className="w-4 h-4 accent-[#F05637] rounded cursor-pointer"
                />
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="space-y-4">
              {profile === undefined ? (
                <p className="text-[#94A3B8]">Loading profile...</p>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="text-[#64748B] font-bold block">Account Display Name</label>
                    <input
                      type="text"
                      readOnly
                      value={profile?.name || user?.displayName || 'Unnamed'}
                      className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none"
                    />
                    <p className="text-[10px] text-[#94A3B8]">
                      Managed in ScatterStudio, not here — this is the same profile every ScatterStudio tool uses.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[#64748B] font-bold block">Email Address</label>
                    <input
                      type="email"
                      readOnly
                      value={user?.email || ''}
                      className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[#64748B] font-bold block">Workspace</label>
                    <input
                      type="text"
                      readOnly
                      value={profile?.workspace || 'ScatterStudio'}
                      className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none"
                    />
                  </div>

                  {profile?.role && (
                    <div className="space-y-1.5">
                      <label className="text-[#64748B] font-bold block">Role</label>
                      <input
                        type="text"
                        readOnly
                        value={profile.role}
                        className="w-full p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-[#0F172A] focus:outline-none capitalize"
                      />
                    </div>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  onClose();
                  void signOut();
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-rose-50/40 hover:bg-rose-50/70 border border-rose-200/50 text-rose-600 text-xs font-semibold transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-[#E2E8F0] bg-[#FFFFFF]/50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-[#64748B] hover:text-[#0F172A]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-xs font-semibold shadow-md shadow-[0_0_15px_rgba(240,86,55,0.3)] transition-all disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{isSaving ? 'Saving...' : 'Save Preferences'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
