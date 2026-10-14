/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, Loader2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiPost } from '../lib/apiClient';
import type { UserUsageStats } from '../types';

type RequestedPlan = 'starter' | 'enterprise' | 'custom';

// What each choice asks for by default; the minutes stay editable.
const PLAN_CHOICES: { id: RequestedPlan; label: string; hint: string; minutes: number }[] = [
  { id: 'starter', label: 'Starter', hint: '50 min every month, just you', minutes: 50 },
  { id: 'enterprise', label: 'Enterprise', hint: '120 min every month, teammates, paid extras', minutes: 120 },
  { id: 'custom', label: 'Custom', hint: 'Tell us what you need', minutes: 300 },
];

interface QuotaRequestDialogProps {
  isOpen: boolean;
  usage: UserUsageStats;
  onClose: () => void;
  onShowToast: (title: string, description?: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

const fieldClass =
  'w-full px-3 py-2 rounded-xl bg-white border border-[#E2E8F0] text-sm text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#F05637]/30 focus:border-[#F05637]';
const labelClass = 'block text-[11px] font-semibold text-[#64748B] mb-1';

/** The Usage page's "Request Quota Increase" form: sent to the ScatterPie team, who move the workspace to a bigger plan. */
export const QuotaRequestDialog: React.FC<QuotaRequestDialogProps> = ({ isOpen, usage, onClose, onShowToast }) => {
  const { user, profile } = useAuth();
  const [name, setName] = useState(profile?.name || user?.displayName || '');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [plan, setPlan] = useState<RequestedPlan>(usage.planId === 'starter' ? 'enterprise' : 'starter');
  const [minutes, setMinutes] = useState(String(PLAN_CHOICES.find((c) => c.id === plan)!.minutes));
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const choosePlan = (id: RequestedPlan) => {
    setPlan(id);
    setMinutes(String(PLAN_CHOICES.find((c) => c.id === id)!.minutes));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const minutesPerMonth = Number(minutes);
    if (!name.trim()) return setError('Enter your name.');
    if (!Number.isInteger(minutesPerMonth) || minutesPerMonth < 1) return setError('Enter the minutes you need each month as a whole number.');
    if (!message.trim()) return setError('Tell us a little about what you will dub.');
    setError(null);
    setSending(true);
    try {
      await apiPost('/api/usage/quota-request', {
        name: name.trim(),
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        plan,
        minutesPerMonth,
        message: message.trim(),
      });
      onShowToast('Request sent', 'The ScatterPie team will review it and get back to you by email.', 'success');
      setMessage('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request could not be sent. Please try again.');
    } finally {
      setSending(false);
    }
  };

  // Drawn on the page itself, like the other dialogs, so the animated Usage screen does not offset it.
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={sending ? undefined : onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="quota-request-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="glass-panel rounded-2xl max-w-lg w-full max-h-[calc(100vh-2rem)] overflow-y-auto p-6 shadow-2xl animate-fade-in space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#FFF4F1] border border-[#FFC4B3] text-[#D94B2E] flex items-center justify-center shrink-0">
              <Gauge className="w-4.5 h-4.5" />
            </div>
            <div>
              <h3 id="quota-request-title" className="text-sm font-bold text-[#0F172A] tracking-tight">
                Request Quota Increase
              </h3>
              <p className="text-xs text-[#64748B] mt-1 leading-relaxed">
                You are on <strong>{usage.activePlan}</strong>: {usage.minutesDubbed.toFixed(1)} of {usage.minutesLimit} min used
                {usage.renewsMonthly === false ? ' in total' : ' this month'}. Tell us what you need and we will move your workspace to a bigger plan.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={sending} aria-label="Close" className="p-1 rounded-lg text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F8FAFC]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="qr-name" className={labelClass}>Name</label>
            <input id="qr-name" className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </div>
          <div>
            <label htmlFor="qr-email" className={labelClass}>Email</label>
            <input id="qr-email" className={`${fieldClass} bg-[#F8FAFC] text-[#64748B]`} value={user?.email || ''} readOnly />
          </div>
          <div>
            <label htmlFor="qr-company" className={labelClass}>Company (optional)</label>
            <input id="qr-company" className={fieldClass} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} />
          </div>
          <div>
            <label htmlFor="qr-phone" className={labelClass}>Phone (optional)</label>
            <input id="qr-phone" type="tel" className={fieldClass} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
          </div>
        </div>

        <fieldset>
          <legend className={labelClass}>Plan you want</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PLAN_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                onClick={() => choosePlan(choice.id)}
                aria-pressed={plan === choice.id}
                className={`text-left p-3 rounded-xl border transition-colors ${
                  plan === choice.id ? 'border-[#F05637] bg-[#FFF4F1]' : 'border-[#E2E8F0] bg-white hover:bg-[#F8FAFC]'
                }`}
              >
                <span className="block text-xs font-bold text-[#0F172A]">{choice.label}</span>
                <span className="block text-[11px] text-[#64748B] mt-0.5 leading-snug">{choice.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="qr-minutes" className={labelClass}>Dubbing minutes you need each month</label>
          <input
            id="qr-minutes"
            type="number"
            min={1}
            max={100000}
            step={1}
            className={fieldClass}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            required
          />
        </div>

        <div>
          <label htmlFor="qr-message" className={labelClass}>What will you dub?</label>
          <textarea
            id="qr-message"
            rows={4}
            className={`${fieldClass} resize-y`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
            placeholder="E.g. weekly training videos into Hindi and Tamil, about 2 hours a month."
            required
          />
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}

        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={sending}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] disabled:opacity-60 text-white text-xs font-semibold shadow-md transition-colors"
          >
            {sending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Send request
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
};
