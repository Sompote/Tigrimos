import { FastifyInstance } from "fastify";
import { getSettings, saveSettings, getFileTokens, saveFileTokens, generateToken } from "../services/data";
import { connectServer, disconnectServer, getMcpStatus, initMcpServers } from "../services/mcp";
import fs from "fs/promises";
import path from "path";
import os from "os";

export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    const settings = await getSettings();
    // Mask API key for security
    const masked = { ...settings };
    if (masked.tigerBotApiKey) {
      masked.tigerBotApiKey = masked.tigerBotApiKey.slice(0, 8) + "..." + masked.tigerBotApiKey.slice(-4);
    }
    if (masked.webSearchApiKey) {
      masked.webSearchApiKey = masked.webSearchApiKey.slice(0, 8) + "..." + masked.webSearchApiKey.slice(-4);
    }
    if (masked.openRouterSearchApiKey) {
      masked.openRouterSearchApiKey = masked.openRouterSearchApiKey.slice(0, 8) + "..." + masked.openRouterSearchApiKey.slice(-4);
    }
    // Mask per-provider API keys
    for (const key of Object.keys(masked)) {
      if (key.startsWith("provider_") && key.endsWith("_apiKey") && masked[key]) {
        masked[key] = masked[key].slice(0, 8) + "..." + masked[key].slice(-4);
      }
    }
    // Mask MCP server header values that look sensitive (Authorization, API keys, etc.)
    if (masked.mcpTools && Array.isArray(masked.mcpTools)) {
      masked.mcpTools = masked.mcpTools.map((tool: any) => {
        if (!tool.headers) return tool;
        const maskedHeaders: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(tool.headers)) {
          const val = hv as string;
          const isSensitive = /auth|key|secret|token|bearer/i.test(hk);
          maskedHeaders[hk] = isSensitive && val.length > 12
            ? val.slice(0, 8) + "..." + val.slice(-4)
            : val;
        }
        return { ...tool, headers: maskedHeaders };
      });
    }
    return masked;
  });

  fastify.put("/", async (request, reply) => {
    const current = await getSettings();
    const body = request.body as any;
    const updated = { ...current, ...body };
    // Don't overwrite keys with masked values
    if (body.tigerBotApiKey?.includes("...")) {
      updated.tigerBotApiKey = current.tigerBotApiKey;
    }
    if (body.webSearchApiKey?.includes("...")) {
      updated.webSearchApiKey = current.webSearchApiKey;
    }
    if (body.openRouterSearchApiKey?.includes("...")) {
      updated.openRouterSearchApiKey = current.openRouterSearchApiKey;
    }
    // Don't overwrite per-provider keys with masked values
    for (const key of Object.keys(body)) {
      if (key.startsWith("provider_") && key.endsWith("_apiKey") && body[key]?.includes("...")) {
        updated[key] = (current as any)[key];
      }
    }
    // Don't overwrite MCP header values with masked values
    if (body.mcpTools && Array.isArray(body.mcpTools) && current.mcpTools && Array.isArray(current.mcpTools)) {
      updated.mcpTools = body.mcpTools.map((tool: any) => {
        if (!tool.headers) return tool;
        const currentTool = current.mcpTools.find((t: any) => t.name === tool.name);
        if (!currentTool?.headers) return tool;
        const restored: Record<string, string> = {};
        for (const [hk, hv] of Object.entries(tool.headers)) {
          const val = hv as string;
          if (val.includes("...") && currentTool.headers[hk]) {
            restored[hk] = currentTool.headers[hk];
          } else {
            restored[hk] = val;
          }
        }
        return { ...tool, headers: restored };
      });
    }
    await saveSettings(updated);
    return { success: true };
  });

  // Test API connection
  fastify.post("/test-connection", async (request, reply) => {
    const { apiKey, apiUrl, model, provider } = request.body as any;
    try {
      const isAnthropic = provider === "anthropic_claude_code" || (apiUrl && apiUrl.includes("api.anthropic.com"));
      if (isAnthropic) {
        const url = (apiUrl || "https://api.anthropic.com/v1").replace(/\/$/, "").replace(/\/messages$/, "") + "/messages";
        // OAuth tokens (sk-ant-oat01-) use Bearer; API keys (sk-ant-api) use x-api-key
        const isOAuthToken = apiKey?.startsWith("sk-ant-oat01-");
        const authHeaders: Record<string, string> = isOAuthToken
          ? { Authorization: `Bearer ${apiKey}` }
          : { "x-api-key": apiKey };
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model || "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 10,
          }),
        });
        if (response.ok) {
          return { success: true, message: "Connection successful (Anthropic API)" };
        } else {
          const err = await response.text();
          return { success: false, message: `Error ${response.status}: ${err}` };
        }
      } else {
        const rawUrl = apiUrl || "https://api.tigerbot.com/bot-chat/openai/v1/chat/completions";
        const url = rawUrl.endsWith("/chat/completions") ? rawUrl : rawUrl.replace(/\/$/, "") + "/chat/completions";
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: model || "TigerBot-70B-Chat",
            messages: [{ role: "user", content: "Hello" }],
            max_tokens: 10,
          }),
        });
        if (response.ok) {
          return { success: true, message: "Connection successful" };
        } else {
          const err = await response.text();
          return { success: false, message: `Error ${response.status}: ${err}` };
        }
      }
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // --- Claude Code OAuth ---

  // Read Claude Code OAuth token from ~/.claude/.credentials.json
  fastify.get("/claude-code-oauth", async (request, reply) => {
    try {
      const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
      const raw = await fs.readFile(credPath, "utf-8");
      const creds = JSON.parse(raw);
      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken) {
        return { success: false, message: "No Claude Code OAuth token found. Please log in to Claude Code first." };
      }
      // Check if token is expired
      if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
        return { success: false, message: "Claude Code OAuth token has expired. Please refresh your Claude Code session." };
      }
      return {
        success: true,
        accessToken: oauth.accessToken,
        expiresAt: oauth.expiresAt,
        subscriptionType: oauth.subscriptionType,
      };
    } catch (err: any) {
      return { success: false, message: "Claude Code credentials not found. Make sure Claude Code is installed and you are logged in." };
    }
  });

  // --- File Access Tokens ---

  fastify.get("/file-tokens", async (request, reply) => {
    const tokens = await getFileTokens();
    return tokens;
  });

  fastify.post("/file-tokens", async (request, reply) => {
    const { name } = request.body as any;
    const tokens = await getFileTokens();
    const newToken = {
      id: Date.now().toString(36),
      name: name || `Token ${tokens.length + 1}`,
      token: generateToken(),
      createdAt: new Date().toISOString(),
    };
    tokens.push(newToken);
    await saveFileTokens(tokens);
    return newToken;
  });

  fastify.delete("/file-tokens/:id", async (request, reply) => {
    let tokens = await getFileTokens();
    tokens = tokens.filter((t) => t.id !== (request.params as any).id);
    await saveFileTokens(tokens);
    return { success: true };
  });

  fastify.post("/file-tokens/:id/regenerate", async (request, reply) => {
    const tokens = await getFileTokens();
    const token = tokens.find((t) => t.id === (request.params as any).id);
    if (!token) { reply.code(404); return { error: "Token not found" }; }
    token.token = generateToken();
    await saveFileTokens(tokens);
    return token;
  });

  // --- MCP Server Management ---

  // Get status of all MCP connections
  fastify.get("/mcp/status", async (request, reply) => {
    return getMcpStatus();
  });

  // Connect to a single MCP server
  fastify.post("/mcp/connect", async (request, reply) => {
    const { name, url, type, headers } = request.body as any;
    if (!name || !url) { reply.code(400); return { error: "name and url required" }; }
    const result = await connectServer({ name, url, enabled: true, type, headers });
    return result;
  });

  // Disconnect a single MCP server
  fastify.post("/mcp/disconnect", async (request, reply) => {
    const { name } = request.body as any;
    if (!name) { reply.code(400); return { error: "name required" }; }
    await disconnectServer(name);
    return { ok: true };
  });

  // Reconnect all MCP servers from settings
  fastify.post("/mcp/reconnect-all", async (request, reply) => {
    await initMcpServers();
    return { ok: true, status: getMcpStatus() };
  });
}
