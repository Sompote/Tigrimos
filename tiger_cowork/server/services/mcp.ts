import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSettings } from "./data";

interface McpToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

interface McpConnection {
  name: string;
  client: Client;
  transport: any;
  tools: McpToolDef[];
  connected: boolean;
}

// Active connections keyed by server name
const connections = new Map<string, McpConnection>();

/**
 * Connect to a single MCP server and discover its tools.
 */
async function connectToServer(config: { name: string; url: string; enabled: boolean; type?: string; headers?: Record<string, string>; command?: string; args?: string[] }): Promise<McpConnection> {
  const client = new Client({ name: "cowork", version: "1.0.0" });

  let transport: any;
  const url = config.url?.trim() || "";
  const serverType = config.type || "auto";

  // Build requestInit with custom headers if provided
  const requestInit: RequestInit | undefined = config.headers && Object.keys(config.headers).length > 0
    ? { headers: config.headers }
    : undefined;

  if (serverType === "stdio" || (!url.startsWith("http://") && !url.startsWith("https://") && serverType === "auto")) {
    // Stdio: use command/args or parse URL as "command arg1 arg2 ..."
    const cmd = config.command || url;
    const parts = cmd.split(/\s+/);
    const command = parts[0];
    const args = config.args || parts.slice(1);
    transport = new StdioClientTransport({ command, args });
    await client.connect(transport);
  } else if (serverType === "sse") {
    // Force SSE transport
    transport = new SSEClientTransport(new URL(url), { requestInit });
    await client.connect(transport);
  } else if (serverType === "http") {
    // Force StreamableHTTP transport
    transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
    await client.connect(transport);
  } else {
    // Auto: Try StreamableHTTP first, fall back to SSE
    try {
      transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
      await client.connect(transport);
    } catch {
      transport = new SSEClientTransport(new URL(url), { requestInit });
      await client.connect(transport);
    }
  }

  // Discover tools
  const toolsResult = await client.listTools();
  const tools: McpToolDef[] = (toolsResult.tools || []).map((t) => ({
    type: "function" as const,
    function: {
      name: `mcp_${config.name}_${t.name}`,
      description: `[MCP: ${config.name}] ${t.description || t.name}`,
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));

  const conn: McpConnection = {
    name: config.name,
    client,
    transport,
    tools,
    connected: true,
  };

  return conn;
}

/**
 * Initialize all enabled MCP servers from settings.
 */
export async function initMcpServers(): Promise<void> {
  // Disconnect existing
  await disconnectAll();

  const settings = await getSettings();
  const servers = settings.mcpTools || [];

  for (const server of servers) {
    if (!server.enabled || !server.url) continue;
    try {
      console.log(`[MCP] Connecting to "${server.name}" (${server.url})...`);
      const conn = await connectToServer(server);
      connections.set(server.name, conn);
      console.log(`[MCP] Connected to "${server.name}" — ${conn.tools.length} tools discovered`);
    } catch (err: any) {
      console.error(`[MCP] Failed to connect to "${server.name}":`, err.message);
    }
  }
}

/**
 * Disconnect all MCP servers.
 */
export async function disconnectAll(): Promise<void> {
  for (const [name, conn] of connections) {
    try {
      await conn.client.close();
    } catch {}
    connections.delete(name);
  }
}

/**
 * Connect (or reconnect) a single MCP server by name.
 */
export async function connectServer(config: { name: string; url: string; enabled: boolean; type?: string; headers?: Record<string, string> }): Promise<{ ok: boolean; tools: number; error?: string }> {
  // Disconnect existing connection for this name
  const existing = connections.get(config.name);
  if (existing) {
    try { await existing.client.close(); } catch {}
    connections.delete(config.name);
  }

  try {
    const conn = await connectToServer(config);
    connections.set(config.name, conn);
    return { ok: true, tools: conn.tools.length };
  } catch (err: any) {
    return { ok: false, tools: 0, error: err.message };
  }
}

/**
 * Disconnect a single MCP server by name.
 */
export async function disconnectServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (conn) {
    try { await conn.client.close(); } catch {}
    connections.delete(name);
  }
}

/**
 * Get all MCP tool definitions (OpenAI function-calling format).
 */
export function getMcpTools(): McpToolDef[] {
  const allTools: McpToolDef[] = [];
  for (const conn of connections.values()) {
    if (conn.connected) {
      allTools.push(...conn.tools);
    }
  }
  return allTools;
}

/**
 * Call an MCP tool by its prefixed name (e.g. "mcp_github_search_repos").
 */
export async function callMcpTool(prefixedName: string, args: any): Promise<any> {
  // Parse "mcp_{serverName}_{toolName}"
  const withoutPrefix = prefixedName.replace(/^mcp_/, "");
  for (const [serverName, conn] of connections) {
    const prefix = serverName + "_";
    if (withoutPrefix.startsWith(prefix)) {
      const toolName = withoutPrefix.slice(prefix.length);
      try {
        const result = await conn.client.callTool({ name: toolName, arguments: args });
        // Extract text content from MCP result
        if (result.content && Array.isArray(result.content)) {
          const texts = result.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text);
          return { ok: true, result: texts.join("\n") };
        }
        return { ok: true, result };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  }
  return { ok: false, error: `MCP tool not found: ${prefixedName}` };
}

/**
 * Get status of all MCP connections.
 */
export function getMcpStatus(): Array<{ name: string; connected: boolean; toolCount: number; tools: string[] }> {
  const status: Array<{ name: string; connected: boolean; toolCount: number; tools: string[] }> = [];
  for (const [name, conn] of connections) {
    status.push({
      name,
      connected: conn.connected,
      toolCount: conn.tools.length,
      tools: conn.tools.map((t) => t.function.name),
    });
  }
  return status;
}

/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp_");
}
