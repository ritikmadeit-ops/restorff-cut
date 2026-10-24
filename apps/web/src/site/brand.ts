// RestorffCut brand constants. One place for names and URLs so a rename is a
// one-file change. SITE_URL is a placeholder until the owner picks a domain
// (no public deploy exists yet).
export const SITE_URL =
	process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:8791";

export const PRODUCT_NAME = "RestorffCut";
export const PARENT_PRODUCT_NAME = "Restorff";
export const COMPANY_NAME = "Overkill";

export const SITE_INFO = {
	title: PRODUCT_NAME,
	description:
		"RestorffCut is the editor inside Restorff: the Edit stage, where a cut is finished and judged before it renders.",
	url: SITE_URL,
	favicon: "/icon.svg",
};
