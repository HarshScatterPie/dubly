// Per-device choices (they depend on this browser's permissions and speakers), kept in localStorage rather than on the account.
export interface DevicePrefs {
  desktopNotifications: boolean;
  completionSound: boolean;
  celebrate: boolean;
}

const KEY = 'dubly:device-prefs';
const DEFAULTS: DevicePrefs = { desktopNotifications: false, completionSound: true, celebrate: true };

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DevicePrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts only for this page.
  }
}

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

// Two soft rising notes, synthesized so no audio file has to ship.
function playChime(): void {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioContextClass();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.16;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // Audio can be blocked before the user has interacted with the page; the toast still shows.
  }
}

// Tells the user a long job finished, the ways they chose: a chime, and a desktop notification when Dubly is not in view.
export function notifyWorkDone(title: string, body: string, opts: { force?: boolean } = {}): void {
  const prefs = loadDevicePrefs();
  if (prefs.completionSound || opts.force) playChime();
  const wantsDesktop = (prefs.desktopNotifications && document.hidden) || opts.force;
  if (wantsDesktop && notificationsSupported() && Notification.permission === 'granted') {
    try {
      const notification = new Notification(title, { body, tag: 'dubly-job' });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker; the chime and toast still happen.
    }
  }
}
