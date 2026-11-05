// Accent themes (UI-03). Only the brand/interactive accent tokens change between themes; their
// values live in `app/globals.css` under `[data-accent='…']`. The preference is per browser
// (localStorage), applied to <html> before first paint by `accentThemeInitScript`.

export const accentThemes = ['violet', 'ocean', 'teal', 'amber'] as const;

export type AccentTheme = (typeof accentThemes)[number];

export const defaultAccentTheme: AccentTheme = 'violet';

export const accentThemeStorageKey = 'ai-agent-manager:accent-theme';

/** Set on <html>; the matching CSS block overrides the `--primary*` tokens. */
export const accentThemeAttribute = 'data-accent';

/** Dispatched on `window` after a change so every mounted selector stays in sync. */
export const accentThemeChangeEvent = 'ai-agent-manager:accent-theme-change';

export const accentThemeLabels: Readonly<Record<AccentTheme, string>> = {
  violet: 'Nebula Violet',
  ocean: 'Ocean Blue',
  teal: 'Aurora Teal',
  amber: 'Solar Amber',
};

export const isAccentTheme = (value: unknown): value is AccentTheme =>
  typeof value === 'string' && (accentThemes as readonly string[]).includes(value);

/** Unknown, missing or tampered values fall back to the default theme. */
export const parseAccentTheme = (value: unknown): AccentTheme =>
  isAccentTheme(value) ? value : defaultAccentTheme;

/**
 * Inline, render-blocking script for the root layout's <head>. It runs before the body is painted,
 * so a stored non-default accent never flashes the default first. Only known theme ids are applied,
 * and storage failures (privacy modes, disabled storage) leave the default in place.
 */
export const accentThemeInitScript = `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(
  accentThemeStorageKey,
)});if(${JSON.stringify(accentThemes)}.indexOf(t)>-1){document.documentElement.setAttribute(${JSON.stringify(
  accentThemeAttribute,
)},t);}}catch(e){}})();`;

type AttributeTarget = Pick<Element, 'getAttribute' | 'setAttribute'>;
type StorageTarget = Pick<Storage, 'setItem'>;

export const readAppliedAccentTheme = (root: AttributeTarget): AccentTheme =>
  parseAccentTheme(root.getAttribute(accentThemeAttribute));

/**
 * Applies the theme immediately and persists it. Persisting is best effort: the theme still
 * applies for this page when storage is unavailable.
 */
export const applyAccentTheme = (
  theme: AccentTheme,
  root: AttributeTarget,
  storage: StorageTarget | undefined,
): void => {
  root.setAttribute(accentThemeAttribute, theme);
  try {
    storage?.setItem(accentThemeStorageKey, theme);
  } catch {
    // Storage can be full or blocked; the in-page theme change still applies.
  }
};
