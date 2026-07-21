import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Tasq — Shared truth for agents", template: "%s — Tasq" },
  description:
    "A local-first coordination kernel that gives humans, agents and runtimes one durable ledger for commitments, ownership, attempts, evidence and effects.",
  openGraph: {
    title: "Tasq — Shared truth for agents",
    description: "Durable coordination truth for humans, agents and runtimes.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
