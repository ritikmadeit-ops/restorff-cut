import { cn } from "@/utils/ui";
import { PRODUCT_NAME } from "@/site/brand";

/** The RESTORFFCUT wordmark: Archivo expanded (wdth 125), 800, uppercase, bone. */
export function Wordmark({
	className,
	size = "md",
}: {
	className?: string;
	size?: "sm" | "md" | "lg";
}) {
	return (
		<span
			className={cn(
				"rc-display text-bone block leading-none select-none",
				size === "sm" && "text-[0.95rem]",
				size === "md" && "text-[1.3rem]",
				size === "lg" && "text-[2rem]",
				className,
			)}
		>
			{PRODUCT_NAME}
		</span>
	);
}
