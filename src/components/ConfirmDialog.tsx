/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Blocking yes/no prompt for actions that can't be undone (deleting a project, discarding
 * unsaved work). Nothing in the app previously stood between a single click on a trash icon
 * and a server-side delete — an easy misclick next to "Share" or "Open" with no way back.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
        className="glass-panel rounded-2xl max-w-sm w-full p-6 shadow-2xl animate-fade-in space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-rose-50 border border-rose-200/60 text-rose-600 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <h3 id="confirm-dialog-title" className="text-sm font-bold text-[#0F172A] tracking-tight">
              {title}
            </h3>
            <p className="text-xs text-[#64748B] mt-1 leading-relaxed">{description}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-md shadow-rose-600/20 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
