// The old copy command, for pages where the clipboard API is not offered.
function copyWithSelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(field);
  previous?.focus?.();
  return copied;
}

/**
 * Copies text to the clipboard and says whether it worked.
 *
 * `navigator.clipboard` exists only on secure origins (https, or localhost). Dubly can be opened over plain http at an IP address, where
 * it is missing and `writeText` fails, so there the selection-based copy is used instead. That one must run inside the click that asked
 * for it, which it does: nothing is awaited before it on that path.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable: fall through to the selection-based copy.
    }
  }
  return copyWithSelection(text);
}
