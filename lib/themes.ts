export const themeGroups = [
  { id: "palettes", label: "Palettes" },
] as const;

export const DEFAULT_APP_THEME_ID = "palette-14-last";

export const appThemes = [
  { id: "palette-13-first", name: "Row 13 · First column", group: "palettes", accent: "#B85CA8", swatch: "#B85CA8", background: "#4D3A4D", glass: "#D49EC2", text: "#EBD8DA", onAccent: "#FFFFFF", muted: "color-mix(in srgb,#EBD8DA 72%,#4D3A4D)", border: "rgba(235,216,218,.2)", colorScheme: "dark" },
  { id: "palette-13-last", name: "Row 13 · Last column", group: "palettes", accent: "#0DA678", swatch: "#0DA678", background: "#FED519", glass: "#073358", text: "#011E3E", onAccent: "#011E3E", muted: "color-mix(in srgb,#011E3E 72%,#FED519)", border: "rgba(1,30,62,.2)", colorScheme: "light" },
  { id: "palette-14-last", name: "Row 14 · Last column", group: "palettes", accent: "#B1D438", swatch: "#B1D438", background: "#FFF5F4", glass: "#158CA2", text: "#000000", onAccent: "#142410", muted: "#444444", border: "rgba(0,0,0,.18)", colorScheme: "light" },
  { id: "palette-15-first", name: "Row 15 · First column", group: "palettes", accent: "#4C546B", swatch: "#4C546B", background: "#1A263E", glass: "#C2402D", text: "#D8D8D8", onAccent: "#FFFFFF", muted: "color-mix(in srgb,#D8D8D8 72%,#1A263E)", border: "rgba(216,216,216,.2)", colorScheme: "dark" },
  { id: "palette-15-second", name: "Row 15 · Second column", group: "palettes", accent: "#C5E874", swatch: "#C5E874", background: "#FAFFA3", glass: "#6AD381", text: "#063835", onAccent: "#063835", muted: "color-mix(in srgb,#063835 72%,#FAFFA3)", border: "rgba(6,56,53,.2)", colorScheme: "light" },
  { id: "palette-16-first", name: "Row 16 · First column", group: "palettes", accent: "#80716A", swatch: "#80716A", background: "#E4DFD9", glass: "#4E433D", text: "#4E433D", onAccent: "#FFFFFF", muted: "#5D514B", border: "rgba(78,67,61,.2)", colorScheme: "light" },
  { id: "palette-16-last", name: "Row 16 · Last column", group: "palettes", accent: "#43785E", swatch: "#43785E", background: "#3F3F3F", glass: "#B5CC98", text: "#F7F7BB", onAccent: "#F7F7BB", muted: "color-mix(in srgb,#F7F7BB 72%,#3F3F3F)", border: "rgba(247,247,187,.2)", colorScheme: "dark" },
] as const;

export type AppThemeId = (typeof appThemes)[number]["id"];

export function isAppThemeId(value: string | null): value is AppThemeId {
  return appThemes.some((theme) => theme.id === value);
}
