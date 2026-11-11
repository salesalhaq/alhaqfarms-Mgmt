export const themeGroups = [
  { id: 'dark', label: 'Dark palettes · gold borders' },
  { id: 'light', label: 'Light palettes · maroon borders' }
] as const;

export const DEFAULT_APP_THEME_ID = 'palette-9';

export const appThemes = [
  { id: 'palette-1', name: '1 · Purple midnight', group: 'dark', accent: '#F0D16A', swatch: '#F0D16A', background: '#17152D', glass: '#373265', text: '#F0CD61', heading: '#FFFFFF' },
  { id: 'palette-2', name: '2 · Deep navy', group: 'dark', accent: '#F0D16A', swatch: '#F0D16A', background: '#11111F', glass: '#282448', text: '#F0CD61', heading: '#FFFFFF' },
  { id: 'palette-3', name: '3 · Indigo violet', group: 'dark', accent: '#F0D16A', swatch: '#F0D16A', background: '#1C1747', glass: '#443C9B', text: '#F0CD61', heading: '#FFFFFF' },
  { id: 'palette-4', name: '4 · Night black', group: 'dark', accent: '#F0D16A', swatch: '#F0D16A', background: '#111016', glass: '#49364B', text: '#F0CD61', heading: '#FFFFFF' },
  { id: 'palette-5', name: '5 · Mint & cream', group: 'light', accent: '#782D40', swatch: '#782D40', background: '#E7F2E9', glass: '#A7E8D7', text: '#172E58', heading: '#172C35' },
  { id: 'palette-6', name: '6 · Pink & sky blue', group: 'light', accent: '#782D40', swatch: '#782D40', background: '#F8E8F4', glass: '#E8A9E3', text: '#172E58', heading: '#24213B' },
  { id: 'palette-7', name: '7 · Blush & aqua', group: 'light', accent: '#782D40', swatch: '#782D40', background: '#F7EDF0', glass: '#F3C9DF', text: '#172E58', heading: '#29243B' },
  { id: 'palette-8', name: '8 · Icy blue', group: 'light', accent: '#782D40', swatch: '#782D40', background: '#DBE8F5', glass: '#A9C5E1', text: '#172E58', heading: '#172A46' },
  { id: 'palette-9', name: '9 ', group: 'light', accent: '#B1D438', swatch: '#B1D438', background: '#FFF5F4', glass: '#158CA2', text: '#000000', onAccent: '#142410', muted: '#444444', border: 'rgba(0,0,0,.18)', colorScheme: 'light' }
] as const;

export type AppThemeId = (typeof appThemes)[number]["id"];

export function isAppThemeId(value: string | null): value is AppThemeId {
  return appThemes.some((theme) => theme.id === value);
}
