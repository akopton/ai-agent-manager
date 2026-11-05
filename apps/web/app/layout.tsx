import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { accentThemeInitScript } from '@/lib/theme/accent-theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Agent Manager',
  description: 'A local workspace for coordinating coding tasks and reviewing agent changes.',
};

// Nebula Minimal is the only theme: native controls, scrollbars and form popups render dark too.
export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#141518',
};

const RootLayout = ({ children }: { children: ReactNode }) => {
  return (
    // The init script may set `data-accent` on <html> before hydration; that attribute is expected.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Applies the stored accent theme before first paint, so it never flashes the default. */}
        <script dangerouslySetInnerHTML={{ __html: accentThemeInitScript }} />
      </head>
      <body className="antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
};

export default RootLayout;
