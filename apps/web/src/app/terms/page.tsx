import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";

// DRAFT for the owner: neutral placeholder terms. No legal promises.
// Replace with reviewed text before any public launch.
export const metadata: Metadata = {
	title: "Terms (draft)",
	description: "Terms for using RestorffCut. Draft.",
};

export default function TermsPage() {
	return (
		<BasePage
			label="Draft · for the owner to review"
			title="Terms"
			description="RestorffCut is part of Restorff by Overkill. These terms are a draft placeholder and are not yet in force."
		>
			<div className="flex flex-col gap-8 text-[0.95rem] leading-relaxed text-[#C9C7C2]">
				<Block label="Status">
					RestorffCut is in development. Features change without notice and
					work stored in the browser can be lost. Keep your own copies of
					anything you import.
				</Block>
				<Block label="Your content">
					What you import and what you render stays yours. You are responsible
					for having the rights to the media you use.
				</Block>
				<Block label="Open-source parts">
					The editor is built on open-source software. Its licences and
					notices ship with the source code (LICENSE and NOTICE).
				</Block>
				<Block label="To be written">
					Payment, accounts, sharing and liability terms are for the owner to
					set before launch.
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
