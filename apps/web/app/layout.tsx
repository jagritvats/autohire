import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/ui/AppShell";
import { THEME_INIT_SCRIPT } from "@/components/ui/ThemeToggle";
import "./globals.css";

// Inter for the interface (tabular figures for scores/counts); JetBrains Mono only for
// code-ish bits — the search query DSL, résumé/LaTeX sources, job types.
const sans = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jbmono", display: "swap" });

export const metadata: Metadata = {
  title: "JobFlow — ranked match feed",
  description: "Job discovery, prep, and assisted-application. The card is the product.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

/**
 * AGPL-3.0 §13: users interacting with JobFlow over a network must be offered its source.
 * Upstream by default; a deployment of a MODIFIED version sets JOBFLOW_SOURCE_URL to its own.
 */
const SOURCE_URL = process.env.JOBFLOW_SOURCE_URL || "https://github.com/jagritvats/autohire";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // the init script sets data-theme before paint, so React must not complain about it
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
        <footer className="site-footer">
          JobFlow · free software under the{" "}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" rel="license noreferrer" target="_blank">
            AGPL-3.0
          </a>{" "}
          ·{" "}
          <a href={SOURCE_URL} rel="noreferrer" target="_blank">
            source
          </a>
        </footer>
      </body>
    </html>
  );
}
