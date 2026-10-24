import { SITE_URL } from "@/site/brand";
import type { MetadataRoute } from "next";

// Only the public, static pages. The editor and project list are app routes
// (disallowed in robots.ts) and the marketing pages were removed.
export default function sitemap(): MetadataRoute.Sitemap {
	return [
		{
			url: `${SITE_URL}/privacy`,
			lastModified: new Date(),
			changeFrequency: "monthly",
			priority: 0.5,
		},
		{
			url: `${SITE_URL}/terms`,
			lastModified: new Date(),
			changeFrequency: "monthly",
			priority: 0.5,
		},
	];
}
