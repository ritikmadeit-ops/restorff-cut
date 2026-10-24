import type { Metadata } from "next";
import { SITE_INFO, SITE_URL } from "@/site/brand";

export const baseMetaData: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: SITE_INFO.title,
		template: `%s · ${SITE_INFO.title}`,
	},
	description: SITE_INFO.description,
	applicationName: SITE_INFO.title,
	openGraph: {
		title: SITE_INFO.title,
		description: SITE_INFO.description,
		url: SITE_URL,
		siteName: SITE_INFO.title,
		locale: "en_US",
		type: "website",
	},
	// The editor is an app, not a marketing site: keep it out of search.
	robots: {
		index: false,
		follow: false,
	},
	appleWebApp: {
		capable: true,
		title: SITE_INFO.title,
	},
	manifest: "/manifest.json",
};
