import { redirect } from "next/navigation";

// RestorffCut has no marketing home page: the editor starts at the project list.
export default function Home() {
	redirect("/projects");
}
