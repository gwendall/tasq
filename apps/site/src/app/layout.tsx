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
    // The words practitioners running several agents actually search with.
    // The gap analysis behind the positioning found the product was
    // undiscoverable under them.
    "agents duplicating work",
    "git worktree agents",
    "agent fleet",
    "persistent agent memory",
    "shared agent backlog",
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        {/*
          Structured data so the product is machine-identifiable. The site had
          none, which left it describing itself only in prose that spoke the
          internal vocabulary rather than the words its audience searches with.
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "Tasq",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "macOS, Linux",
              url: "https://tasq.run",
              description:
                "The project tracker you share with your coding agents. Exclusive expiring "
                + "claims stop agents duplicating work across worktrees and parallel sessions, "
                + "and a replacement agent resumes from the ledger instead of your chat history.",
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
              license: "https://www.apache.org/licenses/LICENSE-2.0",
              codeRepository: "https://github.com/gwendall/tasq",
            }),
          }}
        />
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
