import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono, Plus_Jakarta_Sans, Schibsted_Grotesk } from "next/font/google";
import { AppShell } from "@/components/ui/AppShell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { DEFAULT_STYLE, STYLE_INIT_SCRIPT } from "@/lib/style";
import "./globals.css";
import "./styles/editorial.css";
import "./styles/classic.css";
import "./styles/spark.css";

// Three styles, one tree (lib/style.ts, docs/internal/DESIGN.md "Styles"). Each style picks
// its faces from these variables; all are self-hosted at build by next/font — no font CDN at
// runtime — and only the default style's faces are preloaded (a browser fetches the others
// only once a style uses them).
// Editorial: Fraunces — a soft, optical-size display serif — for titles and the score
// numerals; Schibsted Grotesk, a grotesk drawn for a newsroom's screens, for everything else.
const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});
const grotesk = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });
// Classic: Inter (tabular figures for scores and counts).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", preload: false });
// Spark: Plus Jakarta Sans, a rounded geometric sans.
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-jakarta", display: "swap", preload: false });
// All: JetBrains Mono, only for code-ish bits (the search DSL, résumé/LaTeX sources).
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
const SOURCE_URL = process.env.JOBFLOW_SOURCE_URL || "https://github.com/jagritvats/jobflow";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [display, grotesk, inter, jakarta, mono].map((f) => f.variable).join(" ");
  return (
    // the init scripts set data-theme / data-style before paint, so React must not complain about them
    <html lang="en" className={fonts} data-style={DEFAULT_STYLE} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT + STYLE_INIT_SCRIPT }} />
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
