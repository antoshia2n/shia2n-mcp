import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHighShinTools } from "./tools.js";

export interface Env {
  MCP_SERVER_SECRET: string;
  MCP_DEFAULT_USER_ID: string;
  HIGH_SHIN_API_BASE: string;
  HIGH_SHIN_INTERNAL_SECRET: string;
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "shia2n-mcp", version: "0.1.0" });
  registerHighShinTools(server, env);
  return server;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function authenticate(request: Request, env: Env): boolean {
  if (!env.MCP_SERVER_SECRET) return false;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return timingSafeEqual(token, env.MCP_SERVER_SECRET);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // OPTIONSプリフライトリクエストへの応答
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ name: "shia2n-mcp", version: "0.1.0", status: "ok", mcp_endpoint: "/mcp" }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    if (url.pathname === "/mcp") {
      if (!authenticate(request, env)) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...CORS_HEADERS } }
        );
      }
      const server = createServer(env);
      const mcpResponse = await createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
      // CORSヘッダーを追加して返す
      const newHeaders = new Headers(mcpResponse.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(mcpResponse.body, {
        status: mcpResponse.status,
        headers: newHeaders,
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
} satisfies ExportedHandler<Env>;
