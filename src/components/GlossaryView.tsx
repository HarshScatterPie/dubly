import React, { useEffect, useState } from 'react';
import { BookA, Check, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import type { GlossaryEntry } from '../types';
import { LANGUAGES } from '../data/mockData';
import { workspaceService } from '../services/workspaceService';
import { randomId } from '../lib/randomId';

interface GlossaryViewProps {
  onShowToast: (title: string, desc?: string, type?: 'success' | 'info' | 'error') => void;
}

const inputClass =
  'w-full px-3 py-2 rounded-xl bg-white border border-[#E2E8F0] text-sm text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#F05637]/25 focus:border-[#F05637]/60';

const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name || code;

const emptyEntry = (): GlossaryEntry => ({ id: randomId(), term: '', mode: 'keep' });

// One entry's form, used both to add a term and to edit one in place.
const EntryEditor: React.FC<{ initial: GlossaryEntry; onSave: (entry: GlossaryEntry) => void; onCancel?: () => void; saveLabel: string }> = ({
  initial,
  onSave,
  onCancel,
  saveLabel,
}) => {
  const [entry, setEntry] = useState<GlossaryEntry>(initial);
  const [newLang, setNewLang] = useState(LANGUAGES[0].code);
  const [newTranslation, setNewTranslation] = useState('');
  const translations = entry.translations ?? {};

  const addTranslation = () => {
    if (!newTranslation.trim()) return;
    setEntry({ ...entry, translations: { ...translations, [newLang]: newTranslation.trim() } });
    setNewTranslation('');
  };
  const removeTranslation = (code: string) => {
    const { [code]: _removed, ...rest } = translations;
    setEntry({ ...entry, translations: rest });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (entry.term.trim()) onSave({ ...entry, term: entry.term.trim() });
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={entry.term}
          onChange={(e) => setEntry({ ...entry, term: e.target.value })}
          placeholder="Term as it is spoken, e.g. ScatterPie"
          maxLength={100}
          className={inputClass}
          aria-label="Term"
        />
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs">
          {(['keep', 'translate'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setEntry({ ...entry, mode })}
              className={`flex-1 px-3 py-1.5 rounded-lg font-semibold transition-all ${
                entry.mode === mode ? 'bg-[#F05637] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              {mode === 'keep' ? 'Never translate' : 'Translate as…'}
            </button>
          ))}
        </div>
      </div>

      {entry.mode === 'translate' && (
        <div className="space-y-2">
          {Object.keys(translations).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(translations).map(([code, text]) => (
                <span key={code} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#0F172A]">
                  <span className="text-[#64748B]">{languageName(code)}:</span> {text}
                  <button type="button" onClick={() => removeTranslation(code)} className="text-[#94A3B8] hover:text-red-600" aria-label={`Remove ${languageName(code)}`}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <select value={newLang} onChange={(e) => setNewLang(e.target.value)} className={`${inputClass} w-40 shrink-0`} aria-label="Language">
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
            <input
              value={newTranslation}
              onChange={(e) => setNewTranslation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTranslation();
                }
              }}
              placeholder="Required translation in that language"
              maxLength={200}
              className={inputClass}
              aria-label="Translation"
            />
            <button type="button" onClick={addTranslation} className="px-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] text-xs font-semibold text-[#0F172A] hover:border-[#CBD5E1]">
              Add
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={entry.spokenAs ?? ''}
          onChange={(e) => setEntry({ ...entry, spokenAs: e.target.value })}
          placeholder="Say it as (optional), e.g. Scatter Pie"
          maxLength={100}
          className={inputClass}
          aria-label="Pronunciation"
        />
        <input
          value={entry.note ?? ''}
          onChange={(e) => setEntry({ ...entry, note: e.target.value })}
          placeholder="Note for your team (optional)"
          maxLength={300}
          className={inputClass}
          aria-label="Note"
        />
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-xl text-xs font-semibold text-[#64748B] hover:text-[#0F172A]">
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!entry.term.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#0F172A] text-white text-xs font-semibold disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" />
          {saveLabel}
        </button>
      </div>
    </form>
  );
};

// The workspace glossary: names that must never be translated, fixed translations and pronunciations, applied to every project.
export const GlossaryView: React.FC<GlossaryViewProps> = ({ onShowToast }) => {
  const [saved, setSaved] = useState<GlossaryEntry[]>([]);
  const [draft, setDraft] = useState<GlossaryEntry[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState<GlossaryEntry>(emptyEntry);

  useEffect(() => {
    workspaceService
      .getGlossary()
      .then((res) => {
        setSaved(res.entries);
        setDraft(res.entries);
        setCanEdit(res.canEdit);
      })
      .catch((err) => onShowToast('Could Not Load Glossary', (err as Error).message, 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const hasTerm = (term: string, exceptId?: string) => draft.some((e) => e.id !== exceptId && e.term.toLocaleLowerCase() === term.toLocaleLowerCase());

  const upsert = (entry: GlossaryEntry) => {
    if (hasTerm(entry.term, entry.id)) {
      onShowToast('Already in the Glossary', `"${entry.term}" is already listed.`, 'error');
      return false;
    }
    setDraft((prev) => (prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev, entry]));
    return true;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await workspaceService.saveGlossary(draft);
      setSaved(res.entries);
      setDraft(res.entries);
      onShowToast('Glossary Saved', 'New translations and dubs in this workspace follow it.', 'success');
    } catch (err) {
      onShowToast('Could Not Save Glossary', (err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8]">Workspace</span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">Glossary</h2>
          <p className="text-sm text-[#64748B] mt-1 max-w-2xl">
            Brand names, product terms and jargon Dubly must get right. Translations follow these rules, lines that break them
            are flagged for review, and the voice uses your pronunciations.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="self-start sm:self-auto flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isDirty ? 'Save changes' : 'Saved'}
          </button>
        )}
      </div>

      {!loading && !canEdit && (
        <p className="text-xs text-[#64748B] px-4 py-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
          Only workspace admins can change the glossary. Ask an admin to add a term.
        </p>
      )}

      {canEdit && (
        <div className="rounded-3xl glass-panel p-5 space-y-3">
          <h3 className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#F05637]" /> Add a term
          </h3>
          <EntryEditor
            key={newEntry.id}
            initial={newEntry}
            saveLabel="Add to glossary"
            onSave={(entry) => {
              if (upsert(entry)) setNewEntry(emptyEntry());
            }}
          />
        </div>
      )}

      <div className="rounded-3xl glass-panel overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#E2E8F0]">
          <BookA className="w-4 h-4 text-[#F05637]" />
          <h3 className="text-sm font-bold text-[#0F172A]">Terms</h3>
          <span className="text-xs text-[#94A3B8]">{draft.length}</span>
        </div>
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 text-[#94A3B8] animate-spin" />
          </div>
        ) : draft.length === 0 ? (
          <p className="text-xs text-[#94A3B8] text-center py-10">No terms yet.</p>
        ) : (
          <ul className="divide-y divide-[#E2E8F0]">
            {draft.map((entry) =>
              editingId === entry.id ? (
                <li key={entry.id} className="px-5 py-4">
                  <EntryEditor
                    initial={entry}
                    saveLabel="Done"
                    onCancel={() => setEditingId(null)}
                    onSave={(updated) => {
                      if (upsert(updated)) setEditingId(null);
                    }}
                  />
                </li>
              ) : (
                <li key={entry.id} className="flex items-start gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[#0F172A]">{entry.term}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${
                          entry.mode === 'keep' ? 'bg-slate-50 border-slate-200 text-slate-600' : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        }`}
                      >
                        {entry.mode === 'keep' ? 'Never translated' : 'Fixed translation'}
                      </span>
                      {entry.spokenAs && <span className="text-[11px] text-[#64748B]">said as “{entry.spokenAs}”</span>}
                    </div>
                    {entry.mode === 'translate' && entry.translations && (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(entry.translations).map(([code, text]) => (
                          <span key={code} className="px-2 py-0.5 rounded-md bg-[#F8FAFC] border border-[#E2E8F0] text-[11px] text-[#0F172A]">
                            <span className="text-[#64748B]">{languageName(code)}:</span> {text}
                          </span>
                        ))}
                      </div>
                    )}
                    {entry.note && <p className="text-[11px] text-[#94A3B8]">{entry.note}</p>}
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" onClick={() => setEditingId(entry.id)} className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F8FAFC]" aria-label={`Edit ${entry.term}`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraft((prev) => prev.filter((e) => e.id !== entry.id))}
                        className="p-1.5 rounded-lg text-[#94A3B8] hover:text-red-600 hover:bg-red-50"
                        aria-label={`Remove ${entry.term}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </li>
              )
            )}
          </ul>
        )}
      </div>
    </div>
  );
};
