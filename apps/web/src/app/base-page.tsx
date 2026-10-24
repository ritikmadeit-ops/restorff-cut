import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { COMPANY_NAME, PARENT_PRODUCT_NAME, PRODUCT_NAME } from "@/site/brand";
import { cn } from "@/utils/ui";

interface BasePageProps {
	children: React.ReactNode;
	className?: string;
	mainClassName?: string;
	label?: string;
	title?: string;
	description?: React.ReactNode;
}

/** Shell for the few static pages (privacy, terms): wordmark bar, one column, a quiet footer. */
export function BasePage({
	children,
	className = "",
	mainClassName = "",
	label,
	title,
	description,
}: BasePageProps) {
	return (
		<section className={cn("bg-background min-h-screen", className)}>
			<header className="flex h-[4.25rem] items-center justify-between border-b px-6">
				<Link href="/projects" aria-label={`${PRODUCT_NAME} projects`}>
					<Wordmark />
				</Link>
				<Link href="/projects" className="rc-pill">
					Projects
				</Link>
			</header>
			<main
				className={cn(
					"mx-auto flex max-w-2xl flex-col gap-10 px-6 pt-14 pb-24",
					mainClassName,
				)}
			>
				{title && (
					<div className="flex flex-col gap-4">
						{label && <span className="rc-label">{label}</span>}
						<h1 className="rc-display text-4xl leading-[1.05] md:text-5xl">
							{title}
						</h1>
						{description && (
							<p className="text-muted-foreground text-base leading-relaxed">
								{description}
							</p>
						)}
					</div>
				)}
				{children}
			</main>
			<footer className="rc-mono text-fog border-t px-6 py-6 text-xs">
				{PRODUCT_NAME} is part of {PARENT_PRODUCT_NAME} by {COMPANY_NAME}.
			</footer>
		</section>
	);
}
