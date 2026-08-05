import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { productTruth } from "@/lib/product-truth";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(productTruth.release.website),
  title: { default: "Tasq - The project tracker you share with your agents", template: "%s - Tasq" },
  description:
    "Local-first task tracking for you and your AI agents. They claim work so nothing gets done twice, prove what is finished, and resume where the last session died.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Tasq - The project tracker you share with your agents",
    description:
      "Local-first task tracking. Your agents claim work, prove it is done, and pick up where the last session died.",
    type: "website",
    url: "/",
    siteName: "Tasq",
    // Served with its extension so the type is right without host config.
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Tasq - the project tracker you share with your agents" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tasq - The project tracker you share with your agents",
    description:
      "Local-first task tracking. Your agents claim work, prove it is done, and pick up where the last session died.",
    images: ["/og.png"],
  },
  keywords: [
    "task tracker",
    "AI agents",
    "MCP",
    "Claude Code",
    "Codex",
    "local-first",
    "agent coordination",
    "CLI",
  ],
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
