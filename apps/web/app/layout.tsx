import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Agent Manager",
  description: "A local workspace for coordinating coding tasks and reviewing agent changes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <span className="brand">AI Agent Manager</span>
          <span className="badge">Local workspace</span>
        </header>
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
