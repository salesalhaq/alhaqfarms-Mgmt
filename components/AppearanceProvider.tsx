"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  appThemes,
  DEFAULT_APP_THEME_ID,
  isAppThemeId,
  type AppThemeId,
} from "@/lib/themes";

interface AppearanceContextValue {
  themeId: AppThemeId;
  setThemeId: (themeId: AppThemeId) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function getStoredTheme(staffId: string): AppThemeId {
  if (typeof window === "undefined") return DEFAULT_APP_THEME_ID;
  const storedTheme = window.localStorage.getItem(`alhaqfarms.theme.${staffId}`);
  return isAppThemeId(storedTheme) ? storedTheme : DEFAULT_APP_THEME_ID;
}

export function AppearanceProvider({ staffId, children }: { staffId: string; children: ReactNode }) {
  const [themeId, setThemeId] = useState<AppThemeId>(() => getStoredTheme(staffId));
  const value = useMemo(() => ({ themeId, setThemeId }), [themeId]);

  useEffect(() => {
    setThemeId(getStoredTheme(staffId));
  }, [staffId]);

  useEffect(() => {
    const theme = appThemes.find((candidate) => candidate.id === themeId);
    if (!theme) return;

    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.style.setProperty("--theme-page-bg", theme.background);
    root.style.setProperty("--theme-accent", theme.accent);
    root.style.setProperty("--theme-glass-bg", theme.glass);
    root.style.setProperty("--theme-text", theme.text);
    root.style.setProperty("--theme-on-accent", theme.onAccent);
    root.style.setProperty("--theme-muted", theme.muted);
    root.style.setProperty("--theme-border", theme.border);
    root.style.setProperty("--theme-color-scheme", theme.colorScheme);
    window.localStorage.setItem(`alhaqfarms.theme.${staffId}`, theme.id);
  }, [staffId, themeId]);

  useEffect(() => () => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");
    for (const property of [
      "--theme-page-bg",
      "--theme-accent",
      "--theme-glass-bg",
      "--theme-text",
      "--theme-on-accent",
      "--theme-muted",
      "--theme-border",
      "--theme-color-scheme",
    ]) {
      root.style.removeProperty(property);
    }
  }, []);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("useAppearance must be used within an AppearanceProvider.");
  return context;
}
