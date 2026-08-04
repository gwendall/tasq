import type { MetadataRoute } from "next";

import { productTruth } from "@/lib/product-truth";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${productTruth.release.website}/sitemap.xml`,
  };
}
