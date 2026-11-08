"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_BUSINESS_SETTINGS,
  parseBusinessSettings,
  type BusinessSettings,
} from "@/lib/business-settings";

interface BusinessSettingsContextValue {
  settings: BusinessSettings;
  loading: boolean;
  error: string | null;
  saveSettings: (settings: BusinessSettings) => Promise<void>;
  reload: () => void;
}

const BusinessSettingsContext = createContext<BusinessSettingsContextValue | null>(null);

export function BusinessSettingsProvider({ staffId, children }: { staffId: string; children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULT_BUSINESS_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch("/api/workspace/business-settings", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const result = await response.json() as { settings?: unknown; error?: string };
        if (!response.ok) throw new Error(result.error || "Business settings could not be loaded.");
        const parsed = parseBusinessSettings(result.settings);
        if (active) setSettings(parsed);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Business settings could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [staffId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const saveSettings = useCallback(async (nextSettings: BusinessSettings) => {
    const response = await fetch("/api/workspace/business-settings", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: nextSettings }),
    });
    const result = await response.json() as { settings?: unknown; error?: string };
    if (!response.ok) throw new Error(result.error || "Business settings could not be saved.");
    setSettings(parseBusinessSettings(result.settings));
    setError(null);
  }, []);

  const value = useMemo(
    () => ({ settings, loading, error, saveSettings, reload }),
    [settings, loading, error, saveSettings, reload],
  );
  return <BusinessSettingsContext.Provider value={value}>{children}</BusinessSettingsContext.Provider>;
}

export function useBusinessSettings() {
  const context = useContext(BusinessSettingsContext);
  if (!context) throw new Error("useBusinessSettings must be used within a BusinessSettingsProvider.");
  return context;
}
