import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "JobFlow — ranked match feed",
  description: "Job discovery, prep, and assisted-application. The card is the product.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${serif.variable}`}>
      <body
        style={{
          // bind next/font to the CSS vars used in globals.css
          ["--mono" as string]: `var(--font-mono), ui-monospace, monospace`,
          ["--serif" as string]: `var(--font-serif), Georgia, serif`,
        }}
      >
        {children}
      </body>
    </html>
  );
}
