import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LifecycleButton } from '@/components/tasks/lifecycle-button';
import { taskActions } from '@ai-agent-manager/core';
import { AccentThemeSelector } from '@/components/settings/accent-theme-selector';
import {
  accentThemeAttribute,
  accentThemeInitScript,
  accentThemeLabels,
  accentThemeStorageKey,
  accentThemes,
  applyAccentTheme,
  defaultAccentTheme,
  parseAccentTheme,
  readAppliedAccentTheme,
} from '@/lib/theme/accent-theme';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

const fakeRoot = (initial: string | null = null) => {
  const attributes = new Map<string, string>();
  if (initial !== null) attributes.set(accentThemeAttribute, initial);
  return {
    attributes,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
  };
};

const runInitScript = (getItem: (key: string) => string | null) => {
  const root = fakeRoot();
  runInNewContext(accentThemeInitScript, {
    window: { localStorage: { getItem } },
    document: { documentElement: root },
  });
  return root.attributes.get(accentThemeAttribute);
};

test('parses only known accent themes and defaults to Nebula Violet', () => {
  assert.equal(defaultAccentTheme, 'violet');
  for (const theme of accentThemes) {
    assert.equal(parseAccentTheme(theme), theme);
  }
  for (const value of [null, undefined, '', 'VIOLET', 'pink', 42, { theme: 'ocean' }]) {
    assert.equal(parseAccentTheme(value), 'violet');
  }
  assert.deepEqual(Object.keys(accentThemeLabels), [...accentThemes]);
});

test('the pre-paint script applies a stored theme and ignores unknown or unreadable values', () => {
  assert.equal(
    runInitScript((key) => (key === accentThemeStorageKey ? 'ocean' : null)),
    'ocean',
  );
  assert.equal(
    runInitScript(() => 'amber'),
    'amber',
  );
  assert.equal(
    runInitScript(() => null),
    undefined,
  );
  assert.equal(
    runInitScript(() => '"><script>alert(1)</script>'),
    undefined,
  );
  assert.equal(
    runInitScript(() => {
      throw new Error('SecurityError');
    }),
    undefined,
  );
});

test('applying a theme updates the root immediately and persists it best effort', () => {
  const root = fakeRoot();
  const stored = new Map<string, string>();
  applyAccentTheme('teal', root, { setItem: (key, value) => void stored.set(key, value) });
  assert.equal(readAppliedAccentTheme(root), 'teal');
  assert.equal(stored.get(accentThemeStorageKey), 'teal');

  const blocked = fakeRoot();
  applyAccentTheme('amber', blocked, {
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  });
  assert.equal(readAppliedAccentTheme(blocked), 'amber');

  const withoutStorage = fakeRoot();
  applyAccentTheme('ocean', withoutStorage, undefined);
  assert.equal(readAppliedAccentTheme(withoutStorage), 'ocean');
  assert.equal(readAppliedAccentTheme(fakeRoot('unknown')), 'violet');
});

const declarations = (body: string): Map<string, string> =>
  new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
      name!,
      value!.trim(),
    ]),
  );

const themeBlock = (theme: string): Map<string, string> => {
  const match = new RegExp(`\\[data-accent='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `CSS block for ${theme}`);
  return declarations(match[1]!);
};

const rootTokens = (): Map<string, string> => {
  const match = /\n:root \{([^}]*)\}/.exec(css);
  assert.ok(match, 'main :root token block');
  return declarations(match[1]!);
};

test('accent themes override only the accent tokens; surfaces and status colors are shared', () => {
  const themeSelectors = [...css.matchAll(/\[data-accent='([\w-]+)'\]/g)].map(([, id]) => id);
  assert.deepEqual([...new Set(themeSelectors)].sort(), [...accentThemes].sort());

  for (const theme of accentThemes) {
    assert.deepEqual(
      [...themeBlock(theme).keys()].sort(),
      ['--primary', '--primary-foreground', '--primary-hover'],
      theme,
    );
  }

  const root = rootTokens();
  assert.equal(root.has('--primary'), false, 'primary lives only in theme blocks');
  for (const token of ['--ring', '--sidebar-primary', '--sidebar-ring']) {
    assert.equal(root.get(token), 'var(--primary)', token);
  }
  // Status and surface tokens must not follow the accent.
  for (const token of [
    '--success',
    '--warning',
    '--destructive',
    '--info',
    '--review',
    '--background',
    '--sidebar',
    '--card',
    '--elevated',
    '--border',
  ]) {
    assert.match(root.get(token) ?? '', /^#[0-9a-f]{6}$/, token);
  }
});

const luminance = (hex: string): number => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

test('every accent keeps WCAG AA contrast for button text and accent-colored text', () => {
  const root = rootTokens();
  for (const theme of accentThemes) {
    const block = themeBlock(theme);
    const primary = block.get('--primary')!;
    assert.ok(contrast(primary, block.get('--primary-foreground')!) >= 4.5, `${theme} button text`);
    assert.ok(contrast(block.get('--primary-hover')!, block.get('--primary-foreground')!) >= 4.5);
    for (const surface of ['--background', '--card', '--elevated']) {
      assert.ok(contrast(primary, root.get(surface)!) >= 4.5, `${theme} text on ${surface}`);
    }
  }
});

test('the selector offers each theme as an accessible radio with a scoped swatch', () => {
  const html = renderToStaticMarkup(createElement(AccentThemeSelector));
  assert.match(html, /<legend[^>]*>Accent color<\/legend>/);
  assert.equal(html.match(/type="radio"/g)?.length, accentThemes.length);
  for (const theme of accentThemes) {
    assert.match(html, new RegExp(`data-accent="${theme}"`));
    assert.ok(html.includes(accentThemeLabels[theme]), theme);
  }
  // The server snapshot is the default; the client syncs to the applied theme after hydration.
  assert.match(html, /checked="" value="violet"/);
});

test('the cursor contract covers enabled controls and marks disabled ones', () => {
  assert.match(css, /button:not\(:disabled\),[\s\S]*?\{\s*cursor: pointer;/);
  assert.match(css, /button:disabled,[\s\S]*?\{\s*cursor: not-allowed;/);
});

test('lifecycle text meets AA on its strongest tint across themes and elevated cards', () => {
  const root = rootTokens();
  const rgb = (hex: string) =>
    [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const mix = (foreground: string, background: string, amount: number) => {
    const a = rgb(foreground);
    return (
      '#' +
      rgb(background)
        .map((channel, index) =>
          Math.round(channel * (1 - amount) + a[index]! * amount)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  };
  for (const action of taskActions) {
    if (action === 'stop' || action === 'discard') continue;
    const html = renderToStaticMarkup(createElement(LifecycleButton, { action }, action));
    const token = /--task-status-color:var\((--[a-z-]+)\)/.exec(html)?.[1];
    assert.ok(token);
    const color = root.get(token);
    assert.ok(color);
    for (const theme of accentThemes) {
      assert.equal(themeBlock(theme).has(token), false);
      for (const surface of ['--background', '--card', '--elevated']) {
        assert.ok(
          contrast(color, mix(color, root.get(surface)!, 0.06)) >= 4.5,
          `${theme} ${action} on ${surface}`,
        );
      }
    }
  }
});
