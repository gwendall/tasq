import type { MetadataRoute } from "next";

import { docPages } from "@/lib/docs";
import { productTruth } from "@/lib/product-truth";

const site = productTruth.release.website;

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/agents", "/compare", "/status", "/changelog", "/docs", ...docPages.map((page) => `/docs/${page.slug}`)];
  return routes.map((route) => ({
    url: `${site}${route}`,
    changeFrequency: "weekly",
    priority: route === "" ? 1 : 0.7,
  }));
}
