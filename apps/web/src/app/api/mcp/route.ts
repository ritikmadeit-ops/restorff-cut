// RestorffCut's standalone MCP endpoint (Streamable HTTP, one JSON-RPC message per POST). Tools: timeline,
// timeline_ops, styles, media, look, render (plan/06-mcp.md §4). Handler + auth: src/mcp/handler.ts.
// Connect Claude Code: claude mcp add --transport http restorffcut http://localhost:8791/api/mcp
import { handleMcp } from "@/mcp/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleMcp(request);
export const GET = (request: Request) => handleMcp(request);
export const DELETE = (request: Request) => handleMcp(request);
