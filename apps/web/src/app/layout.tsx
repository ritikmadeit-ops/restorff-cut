import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { Archivo, JetBrains_Mono } from "next/font/google";

// Restorff "screen" type: Archivo (variable width axis, so the wordmark and
// section labels can run expanded at wdth 125) and JetBrains Mono for
// timecodes, rulers, breadcrumbs and version lines.
const archivo = Archivo({
	subsets: ["latin"],
	axes: ["wdth"],
	variable: "--font-archivo",
	display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-jetbrains-mono",
	display: "swap",
});

export const metadata = baseMetaData;

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className={`dark ${archivo.variable} ${jetbrainsMono.variable}`}
			suppressHydrationWarning
		>
			<body className="font-sans antialiased">
				{/* RestorffCut is dark-only: the screen stages never switch theme. */}
				<ThemeProvider
					attribute="class"
					forcedTheme="dark"
					defaultTheme="dark"
					enableSystem={false}
					disableTransitionOnChange={true}
				>
					<TooltipProvider>
						<Toaster />
						{children}
						<div aria-hidden className="rc-grain" />
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
