import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";

// DRAFT for the owner: plain facts about how the editor works as built today.
// No legal promises. Replace with reviewed text before any public launch.
export const metadata: Metadata = {
	title: "Privacy (draft)",
	description: "How RestorffCut handles your data, as built today. Draft.",
};

export default function PrivacyPage() {
	return (
		<BasePage
			label="Draft · for the owner to review"
			title="Privacy"
			description="RestorffCut is part of Restorff by Overkill. This page describes how the editor handles data as it is built today. It is a draft, not a policy."
		>
			<div className="flex flex-col gap-8 text-[0.95rem] leading-relaxed text-[#C9C7C2]">
				<Block label="Where your work lives">
					Projects and imported media are stored in this browser&apos;s own
					storage on this device. Editing, previews and renders run in the
					browser. Clearing the site&apos;s data in your browser deletes them.
				</Block>
				<Block label="What reaches a server">
					Searching the sound library sends your search text to the RestorffCut
					server, which asks Freesound for results. Automatic captions download
					a speech model to your browser the first time you use them; the audio
					itself is processed in the browser.
				</Block>
				<Block label="Accounts and tracking">
					The editor does not ask you to sign in today and loads no analytics
					scripts.
				</Block>
				<Block label="Still to decide">
					Server-side commits and share links are planned. When they arrive this
					page will say what is stored, where, and for how long.
				</Block>
			</div>
		</BasePage>
	);
}

function Block({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2 border-t pt-5">
			<h2 className="rc-label">{label}</h2>
			<p>{children}</p>
		</section>
	);
}
