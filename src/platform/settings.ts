/** Persisted app settings (AsyncStorage on native, localStorage on web) with in-memory subscribers. */
import { kv } from './kv';
import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from './settingsSchema';

export * from './settingsSchema';

const KEY = 'dom.settings.v1';

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();
let cache: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await kv.getItem(KEY);
    cache = raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch (err) {
    console.warn('[settings] could not read settings, using defaults', err);
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  cache = next;
  for (const l of listeners) l(next);
  try {
    await kv.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[settings] could not persist settings', err);
  }
  return next;
}

export async function resetSettings(): Promise<AppSettings> {
  return saveSettings({ ...DEFAULT_SETTINGS });
}

export function subscribeSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Last loaded settings without awaiting (defaults before the first load). */
export function peekSettings(): AppSettings {
  return cache ?? DEFAULT_SETTINGS;
}
