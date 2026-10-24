"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			position="bottom-right"
			offset={20}
			toastOptions={{
				// ui-fix-panels (QA #25): richColors painted success toasts green (not a token). Every toast is the skin's
				// surface with bone text now; the type shows only in the icon and a hairline: success bone, error the
				// destructive token, warning the stale token. The `!` beats sonner's richColors custom properties.
				classNames: {
					toast:
						"group toast group-[.toaster]:!bg-surface group-[.toaster]:!text-bone group-[.toaster]:!border-outline group-[.toaster]:shadow-lg",
					success: "[&_[data-icon]]:!text-bone",
					error: "group-[.toaster]:!border-destructive/60 [&_[data-icon]]:!text-destructive",
					warning: "group-[.toaster]:!border-stale/60 [&_[data-icon]]:!text-stale",
					info: "[&_[data-icon]]:!text-fog",
					title: "group-[.toast]:!text-bone",
					description: "group-[.toast]:!text-fog",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
				},
			}}
			expand={false}
			{...props}
		/>
	);
};

export { Toaster };
