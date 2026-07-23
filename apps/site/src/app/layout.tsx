import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { productTruth } from "@/lib/product-truth";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(productTruth.release.website),
  title: { default: "Tasq - Durable coordination for agents", template: "%s - Tasq" },
  description:
    "A local-first coordination kernel that gives humans, agents and runtimes one durable ledger for commitments, ownership, attempts, evidence and effects.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Tasq - Durable coordination for agents",
    description: "Durable coordination truth for humans, agents and runtimes.",
    type: "website",
    url: "/",
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
