import { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getProtocolStatus } from "../services/protocols";
import { getSettings } from "../services/data";
import { callTigerBotWithTools } from "../services/tigerbot";

const AGENTS_DIR = path.resolve("data/agents");

// Ensure agents directory exists
if (!fs.existsSync(AGENTS_DIR)) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

export async function agentsRoutes(fastify: FastifyInstance) {
  // List all agent YAML configs
  fastify.get("/", async (request, reply) => {
    try {
      const files = fs.readdirSync(AGENTS_DIR)
        .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map(f => {
          const content = fs.readFileSync(path.join(AGENTS_DIR, f), "utf8");
          let parsed: any = {};
          try { parsed = yaml.load(content) as any; } catch {}
          return {
            filename: f,
            name: parsed?.system?.name || f.replace(/\.ya?ml$/, ""),
            agentCount: parsed?.agents?.length || 0,
            updatedAt: fs.statSync(path.join(AGENTS_DIR, f)).mtime.toISOString(),
          };
        });
      return files;
    } catch (err: any) {
      return [];
    }
  });

  // Get a specific agent config
  fastify.get("/:filename", async (request, reply) => {
    const filename = (request.params as any).filename;
    if (!filename.match(/^[\w\-. ]+\.ya?ml$/)) {
      reply.code(400); return { error: "Invalid filename" };
    }
    const fp = path.join(AGENTS_DIR, filename);
    if (!fs.existsSync(fp)) {
      reply.code(404); return { error: "File not found" };
    }
    const content = fs.readFileSync(fp, "utf8");
    let parsed: any = {};
    try { parsed = yaml.load(content); } catch {}
    return { filename, content, parsed };
  });

  // Save agent config (create or update)
  fastify.post("/", async (request, reply) => {
    const { filename, content } = request.body as any;
    if (!filename || !content) {
      reply.code(400); return { error: "filename and content required" };
    }
    const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
    const finalName = safeName.endsWith(".yaml") || safeName.endsWith(".yml")
      ? safeName
      : safeName + ".yaml";

    // Validate YAML
    try {
      yaml.load(content);
    } catch (err: any) {
      reply.code(400); return { error: `Invalid YAML: ${err.message}` };
    }

    fs.writeFileSync(path.join(AGENTS_DIR, finalName), content, "utf8");
    return { ok: true, filename: finalName };
  });

  // Delete agent config
  fastify.delete("/:filename", async (request, reply) => {
    const filename = (request.params as any).filename;
    const fp = path.join(AGENTS_DIR, filename);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
    return { ok: true };
  });

  // Parse YAML content (utility endpoint)
  fastify.post("/parse", async (request, reply) => {
    try {
      const parsed = yaml.load((request.body as any).content);
      return { ok: true, parsed };
    } catch (err: any) {
      reply.code(400); return { ok: false, error: err.message };
    }
  });

  // Generate YAML from editor data
  fastify.post("/generate", async (request, reply) => {
    try {
      const data = request.body as any;
      const yamlContent = yaml.dump(data, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false,
      });
      return { ok: true, content: yamlContent };
    } catch (err: any) {
      reply.code(400); return { ok: false, error: err.message };
    }
  });

  // Generate agent definition using LLM
  fastify.post("/generate-definition", async (request, reply) => {
    const { description } = request.body as any;
    if (!description || typeof description !== "string") {
      reply.code(400); return { ok: false, error: "description is required" };
    }

    try {
      const result = await callTigerBotWithTools(
        [{ role: "user", content: `Based on this description, generate a JSON object for an agent definition.

Description: ${description}

Return ONLY a valid JSON object (no markdown, no code fences) with these fields:
- "name": string (short agent name)
- "role": one of ["orchestrator", "worker", "checker", "reporter", "researcher", "peer"]
- "persona": detailed persona description (2-3 sentences)
- "responsibilities": array of 3-5 responsibility strings

Example:
{"name": "Code Reviewer", "role": "checker", "persona": "You are a meticulous code reviewer who checks for bugs, security issues, and best practices.", "responsibilities": ["Review code for correctness", "Check for security vulnerabilities", "Suggest improvements"]}` }],
        "You are a helpful assistant that generates JSON agent definitions. Return ONLY valid JSON, nothing else. Do not use any tools.",
        undefined,
        undefined,
        undefined,
        [], // no tools
      );

      if (result.content) {
        let jsonStr = result.content.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        try {
          const parsed = JSON.parse(jsonStr);
          return { ok: true, definition: parsed };
        } catch {
          return { ok: false, error: "Failed to parse LLM response", raw: result.content };
        }
      } else {
        return { ok: false, error: "No response from LLM" };
      }
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // Generate a complete agent system using LLM (Auto Architecture)
  fastify.post("/generate-system", async (request, reply) => {
    const { description, architectureType, agentCount } = request.body as any;
    if (!description || typeof description !== "string") {
      reply.code(400); return { ok: false, error: "description is required" };
    }

    const archType = architectureType || "hierarchical";
    const count = agentCount || "auto";

    try {
      const result = await callTigerBotWithTools(
        [{ role: "user", content: `Based on this description, generate a complete multi-agent system configuration as a JSON object.

User Request: ${description}

Architecture Type: ${archType}
Number of Agents: ${count === "auto" ? "Determine the optimal number based on the task" : count}

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:
{
  "system": {
    "name": "System Name",
    "orchestration_mode": "${archType}",
    "communication_protocol": "structured_handoff",
    "context_passing": "full_chain"${archType === "p2p" ? `,
    "p2p_governance": {
      "consensus_mechanism": "contract_net",
      "bid_timeout_seconds": 30,
      "min_confidence_threshold": 0.5,
      "audit_log": true
    }` : ""}
  },
  "agents": [
    {
      "id": "unique_snake_case_id",
      "name": "Agent Display Name",
      "role": "one of: human, orchestrator, worker, checker, reporter, researcher, peer",
      "persona": "Detailed 2-3 sentence persona description",
      "responsibilities": ["responsibility 1", "responsibility 2", "responsibility 3"],
      "bus": { "enabled": true/false, "topics": ["topic1", "topic2"] },
      "mesh": { "enabled": true/false }${archType === "p2p" ? `,
      "p2p": { "confidence_domains": ["domain1", "domain2"], "reputation_score": 0.8 }` : ""}
    }
  ],
  "connections": [
    {
      "from": "source_agent_id",
      "to": "target_agent_id",
      "label": "connection_label",
      "protocol": "one of: tcp, queue",
      "topics": ["topic1"]
    }
  ]
}

IMPORTANT RULES:

CONNECTION POLICY:
- Connections use ONLY "tcp" or "queue" protocol. NEVER use "bus" as a connection protocol.
- Every non-human agent MUST have at least one incoming TCP or queue connection (from human, orchestrator, or another agent). Without an incoming connection, an agent cannot receive tasks and will idle forever.
- "tcp" is for direct point-to-point task delegation. "queue" is for async ordered delivery.
- Connections define access control: an agent can only send_task to agents it has an outgoing connection to.

BUS POLICY:
- Bus is a separate broadcast channel configured per-agent via "bus.enabled", NOT via connection lines.
- Bus is for data sharing and status broadcasting between agents — NOT for task assignment.
- Enable bus on agents that need to share data broadly (e.g., researchers sharing findings, analysts sharing results).
- Bus topics should reflect the data being shared (e.g., "market_data", "status_updates").
- Agents that only do direct task work (no data sharing) do NOT need bus enabled.

ARCHITECTURE RULES:
- Always include exactly ONE agent with role "human" and id "human" as the entry point
- For hierarchical: human connects to orchestrator, orchestrator connects to all workers/checkers/reporters. Workers that delegate must have connections to their targets.
- For flat: human connects to all agents directly
- For mesh: do NOT generate connections — mesh mode bypasses access control so all agents can freely send tasks to any other agent. Only enable bus on agents that need to share broadcast data.
- For hybrid: human connects to ONE orchestrator. Orchestrator connects to all workers via tcp. Workers should have "mesh.enabled: true" so they can collaborate freely with each other without needing connection lines between them. The orchestrator should have "bus.enabled: true" to monitor all agent activity. This combines structured control (orchestrator routes tasks) with flexible peer collaboration (mesh workers). The orchestrator is responsible for preventing infinite loops among mesh agents.
- For pipeline: agents form a sequential chain, each connecting to the next
- For p2p (peer-to-peer swarm): ALL non-human agents MUST use role "peer" (NOT worker/orchestrator). Do NOT generate connections — P2P mode uses a shared blackboard for coordination via Contract Net Protocol (propose → bid → award → execute → complete). Each peer agent MUST have a "p2p" field with "confidence_domains" (list of domains this agent excels at) and "reputation_score" (0-1 initial reputation). Enable "bus.enabled: true" on ALL peer agents for status broadcasting. The system.p2p_governance field defines consensus mechanism (contract_net, majority_voting, weighted_voting, or blackboard). Agents self-organize: they propose tasks on the blackboard, bid with confidence scores, and the best-suited agent wins the work.
- Per-agent mesh: individual agents can have "mesh.enabled: true" which lets them send tasks to any other agent without needing connection lines. Use this for agents that need flexible collaboration (e.g., researchers, analysts). Agents without mesh.enabled must use explicit connections.
- Each non-human agent must have a meaningful persona and 3-5 responsibilities
- Agent IDs must be snake_case (e.g., "design_engineer", "quality_checker")
- Generate between 3-8 agents (including human) unless user specifies otherwise` }],
        "You are an expert multi-agent system architect. Generate complete, well-structured agent system configurations as JSON. Return ONLY valid JSON, nothing else. Do not use any tools.",
        undefined,
        undefined,
        undefined,
        [], // no tools
      );

      if (result.content) {
        let jsonStr = result.content.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        try {
          const parsed = JSON.parse(jsonStr);
          // Validate basic structure
          if (!parsed.system || !parsed.agents || !Array.isArray(parsed.agents)) {
            return { ok: false, error: "LLM returned invalid structure", raw: result.content };
          }
          return { ok: true, system: parsed };
        } catch {
          return { ok: false, error: "Failed to parse LLM response as JSON", raw: result.content };
        }
      } else {
        return { ok: false, error: "No response from LLM" };
      }
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // Validate model availability by calling the provider's /models endpoint
  fastify.post("/validate-model", async (request, reply) => {
    const { model } = request.body as any;
    if (!model || typeof model !== "string") {
      reply.code(400); return { ok: false, error: "model is required" };
    }

    const settings = await getSettings();
    const apiKey = settings.tigerBotApiKey;
    if (!apiKey) {
      return { ok: false, error: "API key not configured", available: false };
    }

    const rawUrl = settings.tigerBotApiUrl || "https://api.tigerbot.com/bot-chat/openai/v1/chat/completions";
    // Derive /models endpoint from the API URL
    const modelsUrl = rawUrl.replace(/\/chat\/completions\/?$/, "/models").replace(/\/$/, "");

    try {
      const response = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        // If /models endpoint is not available, we can't validate -- assume ok
        return { ok: true, available: true, warning: "Cannot list models from provider, model not validated" };
      }

      const data: any = await response.json();
      const models: string[] = (data.data || data.models || []).map((m: any) => typeof m === "string" ? m : m.id || m.name || "");
      const available = models.some((m: string) => m === model || m.includes(model) || model.includes(m));

      return { ok: true, available, models };
    } catch (err: any) {
      // Network error -- can't validate, assume ok
      return { ok: true, available: true, warning: `Could not reach models endpoint: ${err.message}` };
    }
  });

  // Protocol status endpoint
  fastify.get("/protocols/status", async (request, reply) => {
    return getProtocolStatus();
  });
}
