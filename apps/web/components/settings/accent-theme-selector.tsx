'use client';

import { useId, useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';

import {
  accentThemeAttribute,
  accentThemeChangeEvent,
  accentThemeLabels,
  accentThemeStorageKey,
  accentThemes,
  applyAccentTheme,
  defaultAccentTheme,
  parseAccentTheme,
  readAppliedAccentTheme,
  type AccentTheme,
} from '@/lib/theme/accent-theme';
import { cn } from '@/lib/utils';

const subscribe = (notify: () => void): (() => void) => {
  // Another tab changed the preference: follow it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== accentThemeStorageKey) return;
    document.documentElement.setAttribute(accentThemeAttribute, parseAccentTheme(event.newValue));
    notify();
  };
  window.addEventListener(accentThemeChangeEvent, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(accentThemeChangeEvent, notify);
    window.removeEventListener('storage', onStorage);
  };
};

const getSnapshot = (): AccentTheme => readAppliedAccentTheme(document.documentElement);

const getServerSnapshot = (): AccentTheme => defaultAccentTheme;

const localStorageOrUndefined = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const selectTheme = (theme: AccentTheme) => {
  applyAccentTheme(theme, document.documentElement, localStorageOrUndefined());
  window.dispatchEvent(new Event(accentThemeChangeEvent));
};

/**
 * Accent color picker for the Settings page. A native radio group keeps arrow-key navigation and
 * screen reader semantics; each swatch scopes its own theme with `data-accent`, so the preview
 * colors come from the same CSS tokens the app uses.
 */
export const AccentThemeSelector = () => {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const name = useId();

  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Accent color</legend>
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
        {accentThemes.map((theme) => {
          const selected = theme === current;
          return (
            <label key={theme} className="block">
              <input
                type="radio"
                name={name}
                value={theme}
                checked={selected}
                onChange={() => selectTheme(theme)}
                className="peer sr-only"
              />
              <span
                data-accent={theme}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-elevated px-3 py-2.5 text-sm transition-colors peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50',
                  selected
                    ? 'border-primary/70 bg-primary/8'
                    : 'hover:border-border-strong hover:bg-hover',
                )}
              >
                <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
                  <span className="size-5 rounded-full bg-primary ring-2 ring-elevated" />
                  <span className="size-5 rounded-full bg-primary-hover ring-2 ring-elevated" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{accentThemeLabels[theme]}</span>
                  {theme === defaultAccentTheme ? (
                    <span className="block text-xs text-muted-foreground">Default</span>
                  ) : null}
                </span>
                {selected ? (
                  <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
};
