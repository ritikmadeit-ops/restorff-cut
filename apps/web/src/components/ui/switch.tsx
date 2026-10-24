"use client";

import * as React from "react";
import { Switch as SwitchPrimitives } from "radix-ui";

import { cn } from "@/utils/ui";

const Switch = React.forwardRef<
	React.ElementRef<typeof SwitchPrimitives.Root>,
	React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
	<SwitchPrimitives.Root
		className={cn(
			// ui-fix-panels (QA #12): "off" was surface-on-surface (nearly invisible); now an outline track with a fog thumb
			"peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-raised data-[state=unchecked]:border-outline inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
		ref={ref}
	>
		<SwitchPrimitives.Thumb
			className={cn(
				"pointer-events-none block size-4 rounded-full shadow-lg ring-0 data-[state=checked]:bg-background data-[state=unchecked]:bg-fog data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
			)}
		/>
	</SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
