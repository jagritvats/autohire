import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";
import { AppShell } from "@/components/ui/AppShell";
import { THEME_INIT_SCRIPT } from "@/components/ui/ThemeToggle";
import "./globals.css";

// Concept A, "Editorial light" (docs/internal/DESIGN.md): Fraunces — a soft, optical-size
// display serif — for page titles, section heads and the score numerals; Schibsted Grotesk,
// a grotesk drawn for a newsroom's screens, for everything you read and press; JetBrains
// Mono only for code-ish bits (the search DSL, résumé/LaTeX sources). All self-hosted at
// build by next/font — no font CDN at runtime.
const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});
const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jbmono", display: "swap" });

export const metadata: Metadata = {
  title: "JobFlow — ranked match feed",
  description: "Job discovery, prep, and assisted-application. The card is the product.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1e7" },
    { media: "(prefers-color-scheme: dark)", color: "#161411" },
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
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
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
