// A minimal MCP server (Streamable HTTP, JSON responses only) on 127.0.0.1, so a Claude Code
// subprocess can call the copilot's own tools. One server per turn; a random bearer token keeps
// other local processes out. Implements initialize, tools/list, tools/call and ping.
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { LlmTool } from "./types";

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export type ToolRunner = (name: string, input: unknown) => Promise<ToolOutcome>;

export interface McpBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}

const PROTOCOL = "2025-06-18";

export async function startMcpBridge(tools: LlmTool[], run: ToolRunner, name = "blackhole"): Promise<McpBridge> {
  const token = randomBytes(24).toString("hex");
  const sessionId = randomBytes(12).toString("hex");
  const byName = new Set(tools.map((t) => t.name));

  const result = (id: unknown, r: unknown) => ({ jsonrpc: "2.0", id, result: r });
  const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function answer(msg: any): Promise<object | null> {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return failure(msg?.id ?? null, -32600, "Invalid request");
    // Notifications (no id) get no response body.
    if (msg.id === undefined || msg.id === null) return null;
    switch (msg.method) {
      case "initialize":
        return result(msg.id, {
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version: "1.0.0" },
        });
      case "ping":
        return result(msg.id, {});
      case "tools/list":
        return result(msg.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
      case "tools/call": {
        const tool = String(msg.params?.name ?? "");
        if (!byName.has(tool)) return failure(msg.id, -32602, `Unknown tool ${tool}`);
        try {
          const out = await run(tool, msg.params?.arguments ?? {});
          return result(msg.id, { content: [{ type: "text", text: out.content }], isError: !!out.isError });
        } catch (err) {
          return result(msg.id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
        }
      }
      default:
        return failure(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      // No server-initiated stream.
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(failure(null, -32700, "Parse error")));
        return;
      }
      const batch = Array.isArray(parsed);
      const replies = (await Promise.all((batch ? parsed : [parsed]).map(answer))).filter((r): r is object => r !== null);
      if (!replies.length) {
        res.writeHead(202, { "mcp-session-id": sessionId }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": sessionId });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    });
  });
  // A tool waiting on the confirm gate can take minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
