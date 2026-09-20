import { useCallback, useEffect, useState } from 'react';

import { loadSettings, peekSettings, saveSettings, subscribeSettings, type AppSettings } from './settings';

export interface UseSettings {
  settings: AppSettings;
  loaded: boolean;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<AppSettings>(peekSettings);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setLoaded(true);
    });
    const unsubscribe = subscribeSettings((s) => {
      if (alive) setSettings(s);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => saveSettings(patch), []);
  return { settings, loaded, update };
}
