import { FastifyInstance } from "fastify";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { getSettings } from "../services/data";

const execAsync = promisify(exec);

export async function toolsRoutes(fastify: FastifyInstance) {
  // Web search proxy
  fastify.post("/web-search", async (request, reply) => {
    const settings = await getSettings();
    const { query } = request.body as any;
    if (!query) { reply.code(400); return { error: "query required" }; }

    if (!settings.webSearchEnabled) {
      reply.code(400); return { error: "Web search not enabled. Configure in Settings." };
    }

    try {
      const engine = settings.webSearchEngine || "duckduckgo";
      let results: any[] = [];

      if (engine === "google" && settings.webSearchApiKey) {
        const cx = settings.googleSearchCx || "";
        const response = await fetch(
          `https://www.googleapis.com/customsearch/v1?key=${settings.webSearchApiKey}&cx=${cx}&q=${encodeURIComponent(query)}`
        );
        const data = await response.json();
        results = (data.items || []).slice(0, 5).map((item: any) => ({
          title: item.title,
          url: item.link,
          snippet: item.snippet,
        }));
      } else {
        // DuckDuckGo via Python library (HTTP API is blocked by bot detection)
        const safeQuery = query.replace(/'/g, "\\'");
        const pyScript = [
          "import json",
          "try:",
          "    from ddgs import DDGS",
          `    r = list(DDGS().text('${safeQuery}', max_results=5))`,
          "    print(json.dumps(r))",
          "except ImportError:",
          "    from duckduckgo_search import DDGS",
          "    with DDGS() as ddgs:",
          `        r = list(ddgs.text('${safeQuery}', max_results=5))`,
          "        print(json.dumps(r))",
        ].join("\n");
        const tmpFile = `/tmp/ddg_search_${Date.now()}.py`;
        fs.writeFileSync(tmpFile, pyScript);
        const { stdout } = await execAsync(`python3 ${tmpFile}`, { timeout: 30000 });
        try { fs.unlinkSync(tmpFile); } catch {}
        const ddgResults = JSON.parse(stdout.trim());
        results = ddgResults.map((r: any) => ({
          title: r.title || "",
          url: r.href || r.link || "",
          snippet: r.body || r.snippet || "",
        }));
      }

      return { results };
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Fetch a URL (internet access for the AI)
  fastify.post("/fetch", async (request, reply) => {
    const { url, method, headers, body } = request.body as any;
    if (!url) { reply.code(400); return { error: "url required" }; }
    try {
      const response = await fetch(url, {
        method: method || "GET",
        headers: headers || {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const contentType = response.headers.get("content-type") || "";
      let data: any;
      if (contentType.includes("json")) {
        data = await response.json();
      } else {
        data = await response.text();
        // Truncate very large HTML responses
        if (typeof data === "string" && data.length > 50000) {
          data = data.slice(0, 50000) + "\n...(truncated)";
        }
      }
      return { ok: response.ok, status: response.status, data };
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // MCP tool proxy
  fastify.post("/mcp/:toolName", async (request, reply) => {
    const settings = await getSettings();
    const tool = settings.mcpTools?.find((t) => t.name === (request.params as any).toolName && t.enabled);
    if (!tool) { reply.code(404); return { error: "Tool not found or disabled" }; }

    try {
      const response = await fetch(tool.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body as any),
      });
      const data = await response.json();
      return data;
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });
}
