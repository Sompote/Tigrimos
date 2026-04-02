import fs from "fs";
import path from "path";
import { exec, spawn as spawnChild } from "child_process";
import { promisify } from "util";
import yaml from "js-yaml";
import { runPython } from "./python";
import { getSettings, appendAgentHistory, flushAgentHistory } from "./data";
import { getMcpTools, callMcpTool, isMcpTool } from "./mcp";
import {
  tcpOpen, tcpSend, tcpRead, tcpClose,
  busPublish, busSubscribe, busHistory, busGet, busWaitForMessage, busLoadHistory,
  queueEnqueue, queueDequeue, queuePeek, queueDepth, queueDrain,
  getProtocolStatus, cleanupSessionProtocols,
  blackboardPropose, blackboardBid, blackboardAward,
  blackboardStartTask, blackboardCompleteTask, blackboardGet, blackboardGetTask, blackboardGetTasks,
  blackboardGetLog,
} from "./protocols";


const execAsync = promisify(exec);

// --- Tool definitions (OpenAI function-calling format) ---

const builtinTools = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web using DuckDuckGo or Google. Returns search results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_url",
      description: "Fetch content from a URL. Returns the response body (JSON or text, truncated if large).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          method: { type: "string", description: "HTTP method (default GET)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_python",
      description: "Execute Python code in the sandbox. Working directory is output_file/. Use PROJECT_DIR variable to access project files (e.g. os.path.join(PROJECT_DIR, 'uploads/file.xlsx')). Returns stdout, stderr, and any generated files.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_react",
      description: "Execute React/JSX code. The component is compiled with esbuild and rendered natively in the output panel using Recharts (already available — no CDN needed). Write a single default-exported React component. Recharts components (LineChart, BarChart, PieChart, ResponsiveContainer, etc.) are available as globals.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "React JSX component code. Should export or define a default component. Can use hooks, state, etc. IMPORTANT: Keep code under 3000 characters to avoid truncation. For complex UIs, split into multiple run_react calls or use helper functions." },
          title: { type: "string", description: "Title for the HTML page (optional)" },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description: "Additional CDN libraries to include (e.g. 'recharts', 'chart.js'). React and ReactDOM are included by default.",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description: "Execute a shell command. Use for installing packages, git operations, system tasks, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: { type: "string", description: "Working directory (optional)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file from disk. Returns content (truncated if very large).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write or append content to a file on disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" },
          append: { type: "boolean", description: "Append instead of overwrite" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files and directories at a given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: sandbox root)" },
          recursive: { type: "boolean", description: "List recursively" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_skills",
      description: "List all installed skills (both built-in and from ClawHub marketplace). Returns skill names you can load with load_skill.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "load_skill",
      description: "Load the full SKILL.md content for a specific installed skill. This gives you the skill's instructions, commands, and usage examples. Use this when you need to execute a skill.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Skill name/slug (e.g. 'duckduckgo-search', 'youtube-transcript')" },
        },
        required: ["skill"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "clawhub_search",
      description: "Search the ClawHub/OpenClaw skill marketplace.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "clawhub_install",
      description: "Install a skill from ClawHub marketplace by slug.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Skill slug to install" },
          force: { type: "boolean", description: "Force reinstall" },
        },
        required: ["slug"],
      },
    },
  },
];

// Sub-agent spawning tool (conditionally included)
const spawnSubagentTool = {
  type: "function" as const,
  function: {
    name: "spawn_subagent",
    description: "Spawn a sub-agent to handle a specific sub-task independently. The sub-agent gets its own tool-calling loop and returns results when done. Use this for: parallel research, breaking complex tasks into parts, or delegating specialized work. Each sub-agent runs autonomously with full tool access.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear description of the sub-task for the sub-agent to complete" },
        label: { type: "string", description: "Short label for this sub-agent (e.g. 'research-api', 'generate-chart')" },
        context: { type: "string", description: "Optional additional context or data the sub-agent needs" },
        agentId: { type: "string", description: "Optional agent ID from manual YAML config to use specific agent definition" },
      },
      required: ["task"],
    },
  },
};

// ─── Protocol Tools (TCP / Bus / Queue) ───

const tcpTools = [
  {
    type: "function" as const,
    function: {
      name: "proto_tcp_send",
      description: "Send a message to another agent via TCP point-to-point channel. Opens a channel automatically if needed.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target agent ID" },
          topic: { type: "string", description: "Message topic" },
          payload: { type: "string", description: "Message content (JSON string or plain text)" },
        },
        required: ["to", "topic", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_tcp_read",
      description: "Read all messages from a TCP channel with another agent.",
      parameters: {
        type: "object",
        properties: {
          peer: { type: "string", description: "The other agent's ID" },
        },
        required: ["peer"],
      },
    },
  },
];

const busTools = [
  {
    type: "function" as const,
    function: {
      name: "proto_bus_publish",
      description: "Publish a message to the shared event bus. All bus-connected agents on the same session can see it.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic to publish to" },
          payload: { type: "string", description: "Message content" },
        },
        required: ["topic", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_bus_history",
      description: "Read the message history from the event bus, optionally filtered by topic.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Optional topic filter" },
        },
        required: [],
      },
    },
  },
];

const queueTools = [
  {
    type: "function" as const,
    function: {
      name: "proto_queue_send",
      description: "Enqueue a message to another agent's queue (FIFO). The receiving agent can dequeue it later.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target agent ID" },
          topic: { type: "string", description: "Message topic" },
          payload: { type: "string", description: "Message content" },
        },
        required: ["to", "topic", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_queue_receive",
      description: "Dequeue (consume) the next message from your queue, optionally filtered by sender.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender agent ID to read from" },
          topic: { type: "string", description: "Optional topic filter" },
        },
        required: ["from"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_queue_peek",
      description: "Peek at messages in your queue without consuming them.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender agent ID" },
          topic: { type: "string", description: "Optional topic filter" },
          count: { type: "number", description: "Number of messages to peek (default 5)" },
        },
        required: ["from"],
      },
    },
  },
];

// ─── Blackboard / P2P Governance Tools ───

const blackboardTools = [
  {
    type: "function" as const,
    function: {
      name: "bb_propose",
      description: "Propose a new task on the shared blackboard for peer agents to bid on (Contract Net Protocol). Use this when you identify work that needs to be done.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description" },
          task_id: { type: "string", description: "Optional custom task ID" },
        },
        required: ["description"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bb_bid",
      description: "Submit a bid for an open task on the blackboard. Include your confidence score (0-1) indicating how well-suited you are for this task.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to bid on" },
          confidence: { type: "number", description: "Confidence score 0-1 for how well you can handle this task" },
          cost: { type: "number", description: "Optional estimated cost/effort (lower is better)" },
          reasoning: { type: "string", description: "Why you're suited for this task" },
        },
        required: ["task_id", "confidence"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bb_award",
      description: "Award a task to the best bidder. Review bidder profiles from bb_read first, then provide your orchestrator_scores to evaluate each bidder. Final score = 50% bidder confidence + 50% your score. Highest combined score wins. You can also use award_to to override.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to award" },
          award_to: { type: "string", description: "Optional: specific agent ID to award to (overrides scoring)" },
          orchestrator_scores: {
            type: "array",
            description: "Your assessment scores for each bidder based on their profile, expertise, and fit for this task. Each entry: {agent_id, score (0-1), reason}",
            items: {
              type: "object",
              properties: {
                agent_id: { type: "string", description: "Bidder agent ID" },
                score: { type: "number", description: "Your score 0-1 for how well this bidder fits the task" },
                reason: { type: "string", description: "Brief reason for your score" },
              },
              required: ["agent_id", "score"],
            },
          },
        },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bb_complete",
      description: "Mark a task as completed with a result. Use this after you finish the work you were awarded.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to complete" },
          result: { type: "string", description: "Task result / output" },
        },
        required: ["task_id", "result"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bb_read",
      description: "Read the shared blackboard — see all tasks, their status, bids, and results. Optionally filter by status.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Optional: read a specific task" },
          status: { type: "string", enum: ["open", "bidding", "awarded", "in_progress", "completed", "failed"], description: "Optional: filter by status" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bb_log",
      description: "Read the blackboard audit log — append-only event trail of all proposals, bids, votes, awards, and completions for auditability.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries to return (default 50)" },
        },
      },
    },
  },
];

// All protocol tools combined (for backward compat / orchestrator)
const protocolTools = [...tcpTools, ...busTools, ...queueTools];

// OpenRouter Web Search tool (conditionally included)
const openRouterSearchTool = {
  type: "function" as const,
  function: {
    name: "openrouter_web_search",
    description: "Search the web using OpenRouter's Responses API with the web search plugin. Returns AI-summarized results with source citations. Best for detailed, up-to-date answers from the web.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
};

// Get protocol tools filtered by agent config
export function getProtocolToolsForAgent(agentDef?: AgentConfig | null, connections?: any[], systemConfig?: AgentSystemConfig | null): any[] {
  if (!agentDef) return protocolTools; // no config = give all (orchestrator / auto mode)

  const tools: any[] = [];

  // Bus: if agent has bus.enabled, OR hybrid orchestrator (monitors all bus traffic)
  const isHybridOrch = systemConfig?.system?.orchestration_mode === "hybrid" && agentDef.role === "orchestrator";
  if (agentDef.bus?.enabled || isHybridOrch) {
    tools.push(...busTools);
  }

  // TCP/Queue: check if agent has connections using these protocols
  if (connections && connections.length > 0) {
    const agentConns = connections.filter(
      (c: any) => c.from === agentDef.id || c.to === agentDef.id
    );
    const protocols = new Set(agentConns.map((c: any) => c.protocol));
    if (protocols.has("tcp")) tools.push(...tcpTools);
    if (protocols.has("queue")) tools.push(...queueTools);
  } else {
    // No connections info available — give tcp + queue as fallback
    tools.push(...tcpTools, ...queueTools);
  }

  // P2P: if agent is a peer or system is in p2p/p2p_orchestrator mode, add blackboard tools
  const isP2P = systemConfig?.system?.orchestration_mode === "p2p";
  const isP2POrch = systemConfig?.system?.orchestration_mode === "p2p_orchestrator";
  if (isP2P || isP2POrch || agentDef.role === "peer") {
    tools.push(...blackboardTools);
  }

  return tools;
}

// Dynamic tools getter: built-in + MCP tools + conditional OpenRouter search + sub-agent
export async function getTools(opts?: { excludeSubagent?: boolean }) {
  const settings = await getSettings();
  const tools: any[] = [...builtinTools];
  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    tools.push(openRouterSearchTool);
  }
  if (settings.subAgentEnabled && !opts?.excludeSubagent) {
    if (settings.subAgentMode === "realtime") {
      // Realtime mode: use send_task/wait_result instead of spawn_subagent
      tools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    } else {
      tools.push(spawnSubagentTool);
    }
  }
  if (settings.subAgentEnabled) {
    tools.push(...protocolTools);
  }
  return [...tools, ...getMcpTools()];
}

// Get manual agent config summary for system prompt injection
export async function getManualAgentConfigSummary(): Promise<string | null> {
  const settings = await getSettings();
  // Realtime mode has its own summary
  if (settings.subAgentMode === "realtime") return await getRealtimeAgentConfigSummary();
  if (settings.subAgentMode !== "manual" || !settings.subAgentConfigFile) return null;
  const config = loadAgentConfig(settings.subAgentConfigFile);
  if (!config) return null;
  const mode = config.system?.orchestration_mode || "hierarchical";
  let summary = `\n\nAGENT TEAM (${config.system?.name || "Unnamed"}, mode: ${mode}):\n`;
  if (mode === "p2p") {
    summary += `P2P governance: ${config.system?.p2p_governance?.consensus_mechanism || "contract_net"} — coordination via blackboard.\n`;
  }
  for (const a of config.agents || []) {
    const flags = [a.bus?.enabled && "bus", a.mesh?.enabled && "mesh", a.role === "peer" && "peer"].filter(Boolean).join(",");
    summary += `- ${a.id} ("${a.name}"): ${a.role}${flags ? ` [${flags}]` : ""}${a.persona ? ` — ${a.persona}` : ""}\n`;
  }

  if (config.workflow?.sequence && config.workflow.sequence.length > 0) {
    summary += `\nWorkflow sequence:\n`;
    for (const step of config.workflow.sequence) {
      const outputsTo = step.outputs_to ? ` → ${step.outputs_to.join(", ")}` : "";
      summary += `  ${step.step}. ${step.agent}: ${step.action}${outputsTo}\n`;
    }
  }

  summary += `\nSpawn agents with agentId parameter. Follow workflow order. Synthesize results into a clear response with headings.\n`;
  return summary;
}

// Get tools for sub-agents — filters protocol tools based on agent config
export async function getToolsForSubagent(
  currentDepth: number,
  agentDef?: AgentConfig | null,
  connections?: any[],
  systemConfig?: AgentSystemConfig | null
): Promise<any[]> {
  const settings = await getSettings();
  const maxDepth = settings.subAgentMaxDepth || 2;
  const tools: any[] = [...builtinTools];

  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    tools.push(openRouterSearchTool);
  }
  const isManual = settings.subAgentMode === "manual";
  if (settings.subAgentEnabled) {
    if (isManual) {
      // Manual mode: no depth limit — YAML structure is the boundary.
      // Agent gets spawn tool if it has downstream agents, mesh.enabled, or global mesh mode.
      const hasDownstream = agentDef && systemConfig?.workflow?.sequence?.some(
        (step: any) => step.agent === agentDef.id && step.outputs_to?.length > 0
      );
      const hasMesh = agentDef?.mesh?.enabled === true || systemConfig?.system?.orchestration_mode === "mesh";
      const hasP2P = agentDef?.role === "peer" || systemConfig?.system?.orchestration_mode === "p2p";
      if (hasDownstream || hasMesh || hasP2P) tools.push(spawnSubagentTool);
    } else {
      // Auto mode: depth limit applies
      if (currentDepth < maxDepth) tools.push(spawnSubagentTool);
    }
  }
  if (settings.subAgentEnabled) {
    // Only give protocol tools the agent is configured to use
    tools.push(...getProtocolToolsForAgent(agentDef, connections, systemConfig));
  }
  return [...tools, ...getMcpTools()];
}

// Keep backward-compat export (static reference for imports that use `tools`)
export const tools = builtinTools;

// --- Tool implementations ---

async function webSearch(args: { query: string }): Promise<any> {
  const settings = await getSettings();
  const query = args.query;
  const results: any[] = [];

  // Primary: DuckDuckGo Python library (reliable, bypasses bot detection)
  try {
    const safeQuery = query.replace(/'/g, "\\'");
    const pyScript = [
      "import json",
      "try:",
      "    from ddgs import DDGS",
      `    r = list(DDGS().text('${safeQuery}', max_results=8))`,
      "    print(json.dumps(r))",
      "except ImportError:",
      "    from duckduckgo_search import DDGS",
      "    with DDGS() as ddgs:",
      `        r = list(ddgs.text('${safeQuery}', max_results=8))`,
      "        print(json.dumps(r))",
    ].join("\n");
    const tmpFile = `/tmp/ddg_search_${Date.now()}.py`;
    fs.writeFileSync(tmpFile, pyScript);
    const { stdout } = await execAsync(`python3 ${tmpFile}`, { timeout: 30000 });
    try { fs.unlinkSync(tmpFile); } catch {}
    const ddgResults = JSON.parse(stdout.trim());
    for (const r of ddgResults) {
      results.push({
        source: "web",
        title: r.title || "",
        url: r.href || r.link || "",
        text: r.body || r.snippet || "",
      });
    }
  } catch (err: any) {
    console.error("[webSearch] DuckDuckGo Python failed:", err.message);
  }

  // Fallback: DuckDuckGo Instant Answer API (for quick facts/definitions)
  if (results.length === 0) {
    try {
      const ddgRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
      );
      const ddg = await ddgRes.json();
      if (ddg.Abstract) {
        results.push({ source: "abstract", title: ddg.Heading, text: ddg.Abstract, url: ddg.AbstractURL });
      }
      for (const topic of (ddg.RelatedTopics || []).slice(0, 5)) {
        if (topic.Text) {
          results.push({ source: "related", text: topic.Text, url: topic.FirstURL });
        }
      }
    } catch {}
  }

  // If Google is configured, also try Google
  if (settings.webSearchEngine === "google" && settings.webSearchApiKey) {
    try {
      const cx = settings.googleSearchCx || "";
      const gRes = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${settings.webSearchApiKey}&cx=${cx}&q=${encodeURIComponent(query)}`
      );
      const gData = await gRes.json();
      for (const item of (gData.items || []).slice(0, 5)) {
        results.push({ source: "google", title: item.title, url: item.link, text: item.snippet });
      }
    } catch {}
  }

  // Also try Wikipedia search as it's reliable for knowledge queries
  try {
    const wikiRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3`,
      { headers: { "User-Agent": "TigerCowork/1.0" } }
    );
    const wikiData = await wikiRes.json();
    for (const item of (wikiData.query?.search || [])) {
      results.push({
        source: "wikipedia",
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
        text: item.snippet?.replace(/<[^>]+>/g, "") || "",
      });
    }
  } catch {}

  if (results.length === 0) {
    return { results: [], note: "No results found. Try a different query or use fetch_url to access a specific page." };
  }
  return { results };
}

async function fetchUrl(args: { url: string; method?: string }): Promise<any> {
  const { url, method } = args;
  try {
    const response = await fetch(url, {
      method: method || "GET",
      headers: { "User-Agent": "TigerCowork/1.0" },
    });
    const contentType = response.headers.get("content-type") || "";
    let data: any;
    if (contentType.includes("json")) {
      data = await response.json();
    } else {
      data = await response.text();
      if (typeof data === "string" && data.length > 30000) {
        data = data.slice(0, 30000) + "\n...(truncated)";
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function runPythonTool(args: { code: string }, _retryCount: number = 0): Promise<any> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const timeout = settings.pythonTimeout || 300000; // 5 minutes default
  const result = await runPython(args.code, sandboxDir, timeout, _currentProjectWorkingFolder);

  // If Python errored, provide structured error info to help the LLM fix the code
  if (result.exitCode !== 0) {
    const stderr = result.stderr.slice(0, 8000);
    // Extract the most relevant error line (usually the last line of traceback)
    const errorLines = stderr.split("\n").filter(l => l.trim());
    const lastErrorLine = errorLines[errorLines.length - 1] || "";

    // Auto-retry for SyntaxError: attempt automatic fixes before returning error to LLM
    if (/SyntaxError/.test(stderr) && _retryCount < 2) {
      let fixedCode = args.code;
      let didFix = false;

      // Fix 1: Missing closing parentheses — count and append if unbalanced
      const openParens = (fixedCode.match(/\(/g) || []).length;
      const closeParens = (fixedCode.match(/\)/g) || []).length;
      if (openParens > closeParens) {
        fixedCode += ")".repeat(openParens - closeParens);
        didFix = true;
        console.log(`[PythonAutoRetry] Fixed ${openParens - closeParens} unclosed parentheses`);
      }

      // Fix 2: Missing closing brackets
      const openBrackets = (fixedCode.match(/\[/g) || []).length;
      const closeBrackets = (fixedCode.match(/\]/g) || []).length;
      if (openBrackets > closeBrackets) {
        fixedCode += "]".repeat(openBrackets - closeBrackets);
        didFix = true;
        console.log(`[PythonAutoRetry] Fixed ${openBrackets - closeBrackets} unclosed brackets`);
      }

      // Fix 3: Missing closing braces
      const openBraces = (fixedCode.match(/\{/g) || []).length;
      const closeBraces = (fixedCode.match(/\}/g) || []).length;
      if (openBraces > closeBraces) {
        fixedCode += "}".repeat(openBraces - closeBraces);
        didFix = true;
        console.log(`[PythonAutoRetry] Fixed ${openBraces - closeBraces} unclosed braces`);
      }

      // Fix 4: Unterminated triple-quoted string
      const tripleDoubleCount = (fixedCode.match(/"""/g) || []).length;
      if (tripleDoubleCount % 2 !== 0) {
        fixedCode += '\n"""';
        didFix = true;
        console.log(`[PythonAutoRetry] Fixed unterminated triple-double-quoted string`);
      }
      const tripleSingleCount = (fixedCode.match(/'''/g) || []).length;
      if (tripleSingleCount % 2 !== 0) {
        fixedCode += "\n'''";
        didFix = true;
        console.log(`[PythonAutoRetry] Fixed unterminated triple-single-quoted string`);
      }

      // Fix 5: Python 2-style print statements → print()
      const printFix = fixedCode.replace(/^(\s*)print\s+(?!\()(.*?)$/gm, "$1print($2)");
      if (printFix !== fixedCode) {
        fixedCode = printFix;
        didFix = true;
        console.log(`[PythonAutoRetry] Fixed Python 2-style print statements`);
      }

      if (didFix && fixedCode !== args.code) {
        console.log(`[PythonAutoRetry] Attempting auto-fix retry (attempt ${_retryCount + 1}/2)...`);
        return runPythonTool({ code: fixedCode }, _retryCount + 1);
      }
    }

    // Detect common error categories for better recovery hints
    let errorHint = "";
    if (/ModuleNotFoundError|ImportError|No module named/.test(stderr)) {
      const moduleMatch = stderr.match(/No module named '([^']+)'/);
      errorHint = `\n💡 HINT: Missing Python module${moduleMatch ? ` '${moduleMatch[1]}'` : ""}. Install it first with: import subprocess; subprocess.run(['pip', 'install', '${moduleMatch?.[1] || "MODULE_NAME"}'], check=True)`;
    } else if (/FileNotFoundError/.test(stderr)) {
      errorHint = "\n💡 HINT: File not found. Use os.listdir() or os.path.exists() to verify paths before accessing files.";
    } else if (/SyntaxError/.test(stderr)) {
      errorHint = _retryCount > 0
        ? "\n💡 HINT: Python syntax error (auto-fix was attempted but didn't resolve it). Carefully review the code for missing colons, brackets, quotes, or indentation issues."
        : "\n💡 HINT: Python syntax error. Check for missing colons, brackets, quotes, or indentation issues.";
    } else if (/TypeError/.test(stderr)) {
      errorHint = "\n💡 HINT: Type error. Check argument types and function signatures. Print type(variable) to debug.";
    } else if (/PermissionError/.test(stderr)) {
      errorHint = "\n💡 HINT: Permission denied. Try writing to the output directory or /tmp instead.";
    } else if (/MemoryError|Killed/.test(stderr)) {
      errorHint = "\n💡 HINT: Out of memory. Process data in smaller chunks or reduce data size.";
    } else if (/TimeoutError|Timed out/.test(stderr)) {
      errorHint = "\n💡 HINT: Operation timed out. Try with smaller data or add timeout handling.";
    }

    return {
      exitCode: result.exitCode,
      ok: false,
      error: `Python execution failed: ${lastErrorLine}`,
      stdout: result.stdout.slice(0, 20000),
      stderr: stderr + errorHint,
      outputFiles: result.outputFiles,
    };
  }

  // Even on success (exitCode 0), check stderr for important warnings that indicate
  // partial failures — e.g. failed imports that silently degrade output quality
  const stderr0 = result.stderr.slice(0, 5000);
  let warningHint = "";
  if (stderr0) {
    const warningPatterns = [
      { pattern: /Unable to import|ImportError|ModuleNotFoundError|No module named/i, hint: "A Python module failed to import. The output may be incomplete or missing charts/features. Fix the import issue and retry." },
      { pattern: /UserWarning.*(?:Axes3D|mplot3d)/i, hint: "Axes3D/3D plotting failed. Try: import subprocess; subprocess.run(['pip', 'install', '--upgrade', '--break-system-packages', 'matplotlib'], check=True), then retry. Or use 2D plots as alternative." },
      { pattern: /DeprecationWarning.*removed/i, hint: "A deprecated feature was used that may not work. Update the code to use the recommended alternative." },
      { pattern: /RuntimeWarning.*(?:overflow|divide|invalid)/i, hint: "Numerical computation produced warnings (overflow/divide-by-zero). Check your calculations." },
    ];
    for (const wp of warningPatterns) {
      if (wp.pattern.test(stderr0)) {
        warningHint += `\n⚠️ WARNING: ${wp.hint}`;
      }
    }
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 20000),
    stderr: stderr0 + warningHint,
    warnings: warningHint ? warningHint.trim() : undefined,
    outputFiles: result.outputFiles,
  };
}

async function runReactTool(args: { code: string; title?: string; dependencies?: string[] }): Promise<any> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const outputDir = _currentProjectWorkingFolder || path.join(sandboxDir, "output_file");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let code = args.code || "";

  // Strip import statements — React/Recharts are injected at runtime by the client
  code = code.replace(/^\s*import\s+.*?\s+from\s+['"][^'"]+['"];?\s*$/gm, "");
  code = code.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, "");

  // Detect exported component name
  let exportedComponent = "";
  const exportDefaultFuncMatch = code.match(/export\s+default\s+function\s+(\w+)/);
  if (exportDefaultFuncMatch) {
    exportedComponent = exportDefaultFuncMatch[1];
  } else {
    const exportDefaultMatch = code.match(/export\s+default\s+(\w+)\s*;?/);
    if (exportDefaultMatch) exportedComponent = exportDefaultMatch[1];
  }

  // Strip export keywords
  code = code.replace(/export\s+default\s+(function|class)\s+/g, "$1 ");
  code = code.replace(/^\s*export\s+default\s+\w+\s*;?\s*$/gm, "");
  code = code.replace(/^\s*export\s+/gm, "");

  // Detect component names (uppercase function/const/class declarations)
  const componentMatches = code.match(/(?:function|const|class)\s+([A-Z]\w+)/g) || [];
  const componentNames = componentMatches.map((m) => m.replace(/^(?:function|const|class)\s+/, ""));
  const renderTarget = exportedComponent
    || componentNames.find((n) => n === "App")
    || componentNames[componentNames.length - 1]
    || "";

  // Wrap code: destructure React hooks + Recharts at top, return the component at bottom
  const wrapped = `const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment, memo, forwardRef, lazy, Suspense } = React;
const _Recharts = typeof Recharts !== 'undefined' ? Recharts : {};
const { LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ComposedChart, Treemap, Funnel, FunnelChart, RadialBarChart, RadialBar, Sankey, LabelList, Brush, ReferenceLine, ReferenceArea, ReferenceDot, ErrorBar, Label } = _Recharts;

${code}

return ${renderTarget || "null"};`;

  // Compile JSX → JS using esbuild
  let compiled: string;
  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.transform(wrapped, {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    compiled = result.code;
  } catch (err: any) {
    return { ok: false, error: `JSX compilation failed: ${err.message}`, outputFiles: [] };
  }

  // Save as .js with metadata header
  const filename = `react_${Date.now()}.jsx.js`;
  const filePath = path.join(outputDir, filename);
  const meta = JSON.stringify({ title: args.title || "React Component", renderTarget });
  const output = `// __REACT_META__=${meta}\n${compiled}`;

  try {
    fs.writeFileSync(filePath, output, "utf8");
    const relPath = path.relative(sandboxDir, filePath);
    return {
      ok: true,
      outputFiles: [relPath],
      message: `React component compiled to ${relPath}. It will render natively in the output panel.`,
    };
  } catch (err: any) {
    return { ok: false, error: err.message, outputFiles: [] };
  }
}

async function runShell(args: { command?: string; cmd?: string; cwd?: string }): Promise<any> {
  // Accept both "command" and "cmd" since models sometimes use either
  const command = args.command || args.cmd;
  if (!command) return { ok: false, error: "No command provided" };
  const settings = await getSettings();
  const cwd = args.cwd || settings.sandboxDir || process.cwd();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout).slice(0, 20000), stderr: String(stderr).slice(0, 5000) };
  } catch (err: any) {
    return { ok: false, error: err.message, stdout: String(err.stdout || "").slice(0, 10000), stderr: String(err.stderr || "").slice(0, 5000) };
  }
}

function readFileTool(args: { path?: string; file?: string; filepath?: string }): any {
  const filePath = args.path || args.file || args.filepath;
  if (!filePath) return { ok: false, error: "No path provided" };
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) return { ok: false, error: "File not found: " + target };
  const content = fs.readFileSync(target, "utf8");
  return { ok: true, path: target, content: content.slice(0, 30000), truncated: content.length > 30000 };
}

async function writeFileTool(args: { path: string; content: string; append?: boolean }): Promise<any> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const outputDir = _currentProjectWorkingFolder || path.join(sandboxDir, "output_file");
  const target = path.resolve(outputDir, args.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (args.append) {
    fs.appendFileSync(target, args.content, "utf8");
  } else {
    fs.writeFileSync(target, args.content, "utf8");
  }
  // Return outputFiles so the file appears in the output panel
  const ext = path.extname(args.path).toLowerCase();
  const outputExts = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp", ".txt", ".md"];
  const relPath = path.relative(sandboxDir, target);
  const outputFiles = outputExts.includes(ext) ? [relPath] : [];
  return { ok: true, path: target, bytes: Buffer.byteLength(args.content), outputFiles };
}

async function listFilesTool(args: { path?: string; recursive?: boolean }): Promise<any> {
  const settings = await getSettings();
  const target = path.resolve(args.path || settings.sandboxDir || ".");
  if (!fs.existsSync(target)) return { ok: false, error: "Directory not found" };
  const items: { path: string; type: string }[] = [];
  const limit = 200;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (items.length >= limit) return;
      // Skip node_modules and .git
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      items.push({ path: full, type: entry.isDirectory() ? "dir" : "file" });
      if (args.recursive && entry.isDirectory()) walk(full);
    }
  }
  walk(target);
  return { root: target, items, truncated: items.length >= limit };
}

const SKILLS_DIR = path.resolve("Tiger_bot/skills");
const CUSTOM_SKILLS_DIR = path.resolve("skills");

function listSkillsTool(): any {
  // ClawHub skills
  const clawhubSkills: { name: string; files: string[] }[] = [];
  if (fs.existsSync(SKILLS_DIR)) {
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, "SKILL.md"))) {
        const files = fs.readdirSync(path.join(SKILLS_DIR, d.name), { withFileTypes: true })
          .filter((f: any) => !f.isDirectory() && !f.name.startsWith("."))
          .map((f: any) => f.name);
        clawhubSkills.push({ name: d.name, files });
      }
    }
  }

  // Custom uploaded skills
  const customSkills: { name: string; files: string[] }[] = [];
  if (fs.existsSync(CUSTOM_SKILLS_DIR)) {
    const dirs = fs.readdirSync(CUSTOM_SKILLS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        const files = fs.readdirSync(path.join(CUSTOM_SKILLS_DIR, d.name), { withFileTypes: true })
          .filter((f: any) => !f.isDirectory() && !f.name.startsWith("."))
          .map((f: any) => f.name);
        customSkills.push({ name: d.name, files });
      }
    }
  }

  // Registered skills from data/skills.json
  let registeredSkills: { name: string; source: string; enabled: boolean }[] = [];
  try {
    const skillsFile = path.resolve("data/skills.json");
    if (fs.existsSync(skillsFile)) {
      const skills = JSON.parse(fs.readFileSync(skillsFile, "utf8"));
      registeredSkills = skills.map((s: any) => ({ name: s.name, source: s.source, enabled: s.enabled }));
    }
  } catch {}

  return {
    clawhub_skills: clawhubSkills,
    custom_skills: customSkills,
    registered_skills: registeredSkills,
    clawhub_dir: SKILLS_DIR,
    custom_dir: CUSTOM_SKILLS_DIR,
    hint: "Use load_skill with a skill name to see its SKILL.md and supporting files. Works for both ClawHub and custom skills.",
  };
}

function loadSkillTool(args: { skill: string }): any {
  const skillName = args.skill.trim();
  if (!skillName) return { ok: false, error: "Missing skill name" };

  // Search in both ClawHub and custom skills directories
  const searchDirs = [
    { dir: SKILLS_DIR, label: "clawhub" },
    { dir: CUSTOM_SKILLS_DIR, label: "custom" },
  ];

  for (const { dir, label } of searchDirs) {
    const skillBaseDir = path.join(dir, skillName);
    const skillFile = path.join(skillBaseDir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      const content = fs.readFileSync(skillFile, "utf8").replace(/\{baseDir\}/g, skillBaseDir);

      // Collect metadata
      let meta: any = {};
      const metaFile = path.join(skillBaseDir, "_meta.json");
      if (fs.existsSync(metaFile)) {
        try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
      }

      // List all supporting files in the skill folder (recursive)
      const supportingFiles: string[] = [];
      const walkSkillDir = (d: string, prefix: string) => {
        try {
          const entries = fs.readdirSync(d, { withFileTypes: true });
          for (const e of entries) {
            if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
              walkSkillDir(path.join(d, e.name), rel);
            } else if (e.name !== "SKILL.md" && e.name !== "_meta.json") {
              supportingFiles.push(rel);
            }
          }
        } catch {}
      };
      walkSkillDir(skillBaseDir, "");

      return {
        ok: true,
        skill: skillName,
        source: label,
        skillDir: skillBaseDir,
        content: content.slice(0, 15000),
        meta,
        supportingFiles,
        truncated: content.length > 15000,
      };
    }
  }

  return { ok: false, error: `Skill "${skillName}" not found in ${SKILLS_DIR} or ${CUSTOM_SKILLS_DIR}` };
}

async function clawhubSearchTool(args: { query: string; limit?: number }): Promise<any> {
  const { execFile } = await import("child_process");
  const { promisify: prom } = await import("util");
  const execFileAsync = prom(execFile);

  // Find clawhub binary
  const candidates = [
    path.resolve("Tiger_bot/node_modules/.bin/clawhub"),
    "clawhub",
  ];
  let bin = "";
  for (const b of candidates) {
    try {
      await execFileAsync(b, ["--cli-version"], { timeout: 5000 });
      bin = b;
      break;
    } catch {}
  }
  if (!bin) return { ok: false, error: "clawhub CLI not found" };

  const limit = Math.min(50, Math.max(1, args.limit || 10));
  const workdir = path.resolve("Tiger_bot");
  try {
    const { stdout, stderr } = await execFileAsync(
      bin,
      ["search", args.query, "--limit", String(limit), "--no-input", "--workdir", workdir, "--dir", "skills"],
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    return { ok: true, output: stdout.trim(), warning: stderr.trim() };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function clawhubInstallTool(args: { slug: string; force?: boolean }): Promise<any> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.slug)) {
    return { ok: false, error: "Invalid slug format" };
  }

  const { execFile } = await import("child_process");
  const { promisify: prom } = await import("util");
  const execFileAsync = prom(execFile);

  const candidates = [
    path.resolve("Tiger_bot/node_modules/.bin/clawhub"),
    "clawhub",
  ];
  let bin = "";
  for (const b of candidates) {
    try {
      await execFileAsync(b, ["--cli-version"], { timeout: 5000 });
      bin = b;
      break;
    } catch {}
  }
  if (!bin) return { ok: false, error: "clawhub CLI not found" };

  const workdir = path.resolve("Tiger_bot");
  const argv = ["install", args.slug, "--no-input", "--workdir", workdir, "--dir", "skills"];
  if (args.force) argv.push("--force");

  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, { timeout: 120000, maxBuffer: 1024 * 1024 });
    return { ok: true, slug: args.slug, output: stdout.trim(), warning: stderr.trim() };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// --- OpenRouter Web Search ---

async function openRouterWebSearch(args: { query: string }): Promise<any> {
  const settings = await getSettings();
  const apiKey = settings.openRouterSearchApiKey;
  if (!apiKey) return { ok: false, error: "OpenRouter API key not configured" };

  const model = settings.openRouterSearchModel || "openai/gpt-4.1-mini";
  const maxTokens = settings.openRouterSearchMaxTokens || 4096;
  const maxResults = Math.min(10, Math.max(1, settings.openRouterSearchMaxResults || 5));

  try {
    const response = await fetch("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: args.query,
        max_output_tokens: maxTokens,
        tools: [{ type: "web_search_preview", search_context_size: "medium" }],
        plugins: [{ id: "web", max_results: maxResults }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, error: `OpenRouter API error ${response.status}: ${errText}` };
    }

    const data = await response.json();

    // Extract text and citations from response
    const output = data.output || [];
    let text = "";
    const citations: Array<{ url: string; title?: string }> = [];

    for (const item of output) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) {
          if (block.type === "output_text") {
            text += block.text || "";
            // Collect annotations/citations
            for (const ann of (block.annotations || [])) {
              if (ann.type === "url_citation" && ann.url) {
                citations.push({ url: ann.url, title: ann.title });
              }
            }
          }
        }
      }
    }

    return {
      ok: true,
      text: text.slice(0, 15000),
      citations: citations.slice(0, 20),
      model,
      usage: data.usage,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// --- Manual agent config loading ---

interface AgentConfig {
  id: string;
  name: string;
  role: string;  // human, orchestrator, worker, checker, reporter, researcher, peer
  model: string;
  persona: string;
  responsibilities: string[];
  constraints?: string[];
  tools_allowed?: string[];
  bus?: {
    enabled: boolean;
    topics?: string[];
  };
  mesh?: {
    enabled: boolean;
  };
  p2p?: {
    bidder?: boolean;                // whether this agent can bid on blackboard tasks
    confidence_domains?: string[];   // domains this agent is confident in
    reputation_score?: number;       // 0-1, initial reputation
  };
}

interface P2PGovernanceConfig {
  consensus_mechanism: "contract_net";
  bid_timeout_seconds?: number;      // how long to wait for bids (default 30)
  vote_timeout_seconds?: number;     // how long to wait for votes (default 30)
  min_confidence_threshold?: number; // minimum confidence to accept a bid (0-1)
  max_task_retries?: number;         // max retries if task fails (default 2)
  audit_log?: boolean;               // enable append-only event log (default true)
  auto_assign_threshold?: number;    // if ≤ this many bidders, skip bidding and auto-assign (default 2)
}

interface AgentSystemConfig {
  system: {
    name: string;
    orchestration_mode: string;  // hierarchical, flat, mesh, hybrid, pipeline, p2p, p2p_orchestrator
    p2p_governance?: P2PGovernanceConfig;
  };
  agents: AgentConfig[];
  connections?: any[];
  workflow?: any;
  communication?: any;
}

// --- Claude Code CLI Agent ---

/** Check if a model string indicates Claude Code CLI should be used */
export function isClaudeCodeModel(model?: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase().trim();
  return m === "claude-code" || m === "claude_code" || m === "claude-code-cli" || m.startsWith("claude-code:");
}

/**
 * Run a task using Claude Code CLI (`claude -p`).
 * Claude Code is a full autonomous agent with its own tool loop —
 * it handles Read, Edit, Bash, Glob, Grep, etc. internally.
 * No API key needed — uses the local OAuth login.
 */
export async function runClaudeCodeAgent(
  task: string,
  opts: {
    workingDir?: string;
    systemPrompt?: string;
    signal?: AbortSignal;
    timeout?: number;  // ms, default 5 minutes
    onToolCall?: (name: string, args: any) => void;
    onText?: (text: string) => void;
    maxTurns?: number;
    model?: string;     // sub-model override (e.g. "sonnet", "opus")
  } = {},
): Promise<{ content: string; toolResults?: any[]; toolCalls?: string[] }> {
  const settings = await getSettings();
  const workDir = opts.workingDir || _currentProjectWorkingFolder || settings.sandboxDir || process.cwd();
  const timeout = opts.timeout || 300_000; // 5 min default
  const maxTurns = opts.maxTurns || 25;

  // Build the prompt: include system prompt context if provided
  let fullPrompt = task;
  if (opts.systemPrompt) {
    fullPrompt = `${opts.systemPrompt}\n\n---\n\nTASK:\n${task}`;
  }

  // Build CLI args
  const cliArgs: string[] = [
    "-p", fullPrompt,
    "--output-format", "stream-json",
    "--max-turns", String(maxTurns),
    "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
    "--verbose",
  ];

  // Pass sub-model if specified (e.g. "claude-code:sonnet" → "--model sonnet")
  if (opts.model) {
    cliArgs.push("--model", opts.model);
  }

  console.log(`[ClaudeCode] Spawning claude CLI in ${workDir} (timeout: ${timeout}ms, maxTurns: ${maxTurns}${opts.model ? `, model: ${opts.model}` : ""})`);

  return new Promise((resolve, reject) => {
    const child = spawnChild("claude", cliArgs, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resultText = "";
    let stderrText = "";
    const toolCalls: string[] = [];
    let settled = false;

    // Timeout handler
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        console.log(`[ClaudeCode] Timeout after ${timeout}ms`);
        resolve({
          content: resultText || `Claude Code timed out after ${timeout / 1000}s. Partial output may be available.`,
          toolCalls,
        });
      }
    }, timeout);

    // Abort signal handler
    if (opts.signal) {
      const onAbort = () => {
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          clearTimeout(timeoutId);
          resolve({ content: resultText || "Task was cancelled.", toolCalls });
        }
      };
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
        clearTimeout(timeoutId);
        return resolve({ content: "Task was cancelled.", toolCalls });
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Parse streaming JSON output line by line
    let buffer = "";
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Handle different event types from Claude Code stream-json
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                resultText += block.text;
                if (opts.onText) opts.onText(block.text);
              }
              if (block.type === "tool_use" && block.name) {
                toolCalls.push(block.name);
                if (opts.onToolCall) {
                  opts.onToolCall(block.name, block.input || {});
                }
              }
            }
          } else if (event.type === "result") {
            // Final result event
            if (event.result) {
              resultText = event.result;
            }
          }
        } catch {
          // Non-JSON line or partial — ignore
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderrText += data.toString();
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;

      if (code !== 0 && !resultText) {
        console.error(`[ClaudeCode] Exited with code ${code}. stderr: ${stderrText.slice(0, 500)}`);
        resolve({
          content: `Claude Code exited with code ${code}. Error: ${stderrText.slice(0, 2000)}`,
          toolCalls,
        });
      } else {
        console.log(`[ClaudeCode] Completed. Tools used: ${toolCalls.length}, result length: ${resultText.length}`);
        resolve({
          content: resultText || "(no output)",
          toolCalls,
        });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      console.error(`[ClaudeCode] Spawn error:`, err.message);
      reject(new Error(`Failed to spawn Claude Code CLI: ${err.message}. Is 'claude' installed and in PATH?`));
    });
  });
}

// --- OpenAI Codex CLI Agent ---

/** Check if a model string indicates Codex CLI should be used */
export function isCodexModel(model?: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase().trim();
  return m === "codex" || m === "codex-cli" || m === "openai-codex" || m.startsWith("codex:");
}

/** Check if model is any local CLI agent (Claude Code or Codex) */
export function isLocalCliAgent(model?: string): boolean {
  return isClaudeCodeModel(model) || isCodexModel(model);
}

/** Extract sub-model from model string (e.g. "claude-code:sonnet" → "sonnet", "codex:o3" → "o3", "claude-code" → undefined) */
export function extractCliSubModel(model?: string): string | undefined {
  if (!model) return undefined;
  const idx = model.indexOf(":");
  if (idx < 0) return undefined;
  const sub = model.slice(idx + 1).trim();
  return sub || undefined;
}

/**
 * Run a task using OpenAI Codex CLI (`codex exec`).
 * Codex is a full autonomous agent with its own tool loop —
 * it handles file reading, editing, and shell commands internally.
 * Uses codex login OAuth or CODEX_API_KEY env var.
 */
export async function runCodexAgent(
  task: string,
  opts: {
    workingDir?: string;
    systemPrompt?: string;
    signal?: AbortSignal;
    timeout?: number;
    onToolCall?: (name: string, args: any) => void;
    onText?: (text: string) => void;
    model?: string;     // sub-model override (e.g. "o3", "o4-mini")
  } = {},
): Promise<{ content: string; toolResults?: any[]; toolCalls?: string[] }> {
  const settings = await getSettings();
  const workDir = opts.workingDir || _currentProjectWorkingFolder || settings.sandboxDir || process.cwd();
  const timeout = opts.timeout || 300_000;

  // Build the prompt
  let fullPrompt = task;
  if (opts.systemPrompt) {
    fullPrompt = `${opts.systemPrompt}\n\n---\n\nTASK:\n${task}`;
  }

  // Codex CLI args: exec mode, JSON streaming, full auto
  const cliArgs: string[] = [
    "exec",
    fullPrompt,
    "--json",
    "--full-auto",
  ];

  // Pass sub-model if specified (e.g. "codex:o3" → "-m o3")
  if (opts.model) {
    cliArgs.push("-m", opts.model);
  }

  console.log(`[Codex] Spawning codex CLI in ${workDir} (timeout: ${timeout}ms${opts.model ? `, model: ${opts.model}` : ""})`);

  return new Promise((resolve, reject) => {
    const child = spawnChild("codex", cliArgs, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resultText = "";
    let stderrText = "";
    const toolCalls: string[] = [];
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        console.log(`[Codex] Timeout after ${timeout}ms`);
        resolve({
          content: resultText || `Codex timed out after ${timeout / 1000}s.`,
          toolCalls,
        });
      }
    }, timeout);

    if (opts.signal) {
      const onAbort = () => {
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          clearTimeout(timeoutId);
          resolve({ content: resultText || "Task was cancelled.", toolCalls });
        }
      };
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
        clearTimeout(timeoutId);
        return resolve({ content: "Task was cancelled.", toolCalls });
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Parse JSONL output from codex --json
    let buffer = "";
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Codex JSONL event types
          if (event.type === "item.completed" && event.item) {
            const item = event.item;
            if (item.type === "agent_message" && item.text) {
              // Agent text response
              resultText += item.text;
              if (opts.onText) opts.onText(item.text);
            } else if (item.type === "command_execution") {
              // Shell command execution
              const toolName = item.command || "shell";
              toolCalls.push(toolName);
              if (opts.onToolCall) opts.onToolCall("shell", { command: item.command });
              // Append command output to result for context
              if (item.aggregated_output) {
                resultText += item.aggregated_output;
                if (opts.onText) opts.onText(item.aggregated_output);
              }
            } else if (item.type === "file_edit" || item.type === "file_read") {
              // File operations
              const toolName = item.type;
              toolCalls.push(toolName);
              if (opts.onToolCall) opts.onToolCall(toolName, { path: item.path || item.file });
            } else if (item.type === "message" && item.content) {
              // Legacy/alternate message format
              for (const block of (Array.isArray(item.content) ? item.content : [item.content])) {
                if (block.type === "output_text" || block.type === "text") {
                  const text = block.text || block.output || "";
                  resultText += text;
                  if (opts.onText) opts.onText(text);
                } else if (typeof block === "string") {
                  resultText += block;
                  if (opts.onText) opts.onText(block);
                }
              }
            } else if (item.type === "function_call" || item.type === "tool_use") {
              const toolName = item.name || item.function?.name || "unknown";
              toolCalls.push(toolName);
              if (opts.onToolCall) opts.onToolCall(toolName, item.arguments || item.input || {});
            }
          } else if (event.type === "turn.completed") {
            // End of turn — no additional output extraction needed
          } else if (event.type === "message" && event.content) {
            // Simple message event
            const text = typeof event.content === "string" ? event.content : JSON.stringify(event.content);
            resultText += text;
            if (opts.onText) opts.onText(text);
          }
        } catch {
          // Non-JSON line — might be plain text output
          if (line.trim() && !line.startsWith("{")) {
            resultText += line + "\n";
          }
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderrText += data.toString();
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;

      if (code !== 0 && !resultText) {
        console.error(`[Codex] Exited with code ${code}. stderr: ${stderrText.slice(0, 500)}`);
        resolve({
          content: `Codex exited with code ${code}. Error: ${stderrText.slice(0, 2000)}`,
          toolCalls,
        });
      } else {
        console.log(`[Codex] Completed. Tools used: ${toolCalls.length}, result length: ${resultText.length}`);
        resolve({ content: resultText || "(no output)", toolCalls });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      console.error(`[Codex] Spawn error:`, err.message);
      reject(new Error(`Failed to spawn Codex CLI: ${err.message}. Is 'codex' installed and in PATH?`));
    });
  });
}

export function loadAgentConfig(filename: string): AgentSystemConfig | null {
  const agentsDir = path.resolve("data/agents");
  const fp = path.join(agentsDir, filename);
  if (!fs.existsSync(fp)) return null;
  try {
    const content = fs.readFileSync(fp, "utf8");
    return yaml.load(content) as AgentSystemConfig;
  } catch (err) {
    console.error(`[AgentConfig] Failed to parse ${filename}:`, err);
    return null;
  }
}

function getManualAgentPrompt(agentDef: AgentConfig, systemConfig: AgentSystemConfig): string {
  let prompt = `You are "${agentDef.name}" (ID: ${agentDef.id}), a ${agentDef.role} in the "${systemConfig.system.name}" system.\n\n`;
  if (agentDef.persona) {
    prompt += `PERSONA:\n${agentDef.persona}\n\n`;
  }
  if (agentDef.responsibilities && agentDef.responsibilities.length > 0) {
    prompt += `RESPONSIBILITIES:\n${agentDef.responsibilities.map(r => `- ${r}`).join("\n")}\n\n`;
  }
  if (agentDef.constraints && agentDef.constraints.length > 0) {
    prompt += `CONSTRAINTS:\n${agentDef.constraints.map(c => `- ${c}`).join("\n")}\n\n`;
  }
  // Determine downstream agents this agent can spawn (from workflow outputs_to + connections)
  const workflowStep = systemConfig.workflow?.sequence?.find((s: any) => s.agent === agentDef.id);
  const outputsTo: string[] = workflowStep?.outputs_to || [];
  const connTargets = (systemConfig.connections || [])
    .filter((c: any) => c.from === agentDef.id)
    .map((c: any) => c.to);
  const downstream = [...new Set([...outputsTo, ...connTargets])];

  const isP2P = systemConfig.system?.orchestration_mode === "p2p";
  const isP2POrchestrator = systemConfig.system?.orchestration_mode === "p2p_orchestrator";

  if (isP2P) {
    const allPeers = (systemConfig.agents || [])
      .filter((a: AgentConfig) => a.id !== agentDef.id && a.role !== "human")
      .map((a: AgentConfig) => `  - ${a.id} ("${a.name}", role: ${a.role})`)
      .join("\n");
    const governance = systemConfig.system?.p2p_governance;
    const mechanism = governance?.consensus_mechanism || "contract_net";
    prompt += `P2P SWARM MODE:\n`;
    prompt += `You are an autonomous peer in a flat P2P swarm. No agent holds persistent authority.\n`;
    prompt += `Consensus mechanism: ${mechanism}\n`;
    if (agentDef.p2p?.confidence_domains?.length) {
      prompt += `Your expertise: ${agentDef.p2p.confidence_domains.join(", ")}\n`;
    }
    prompt += `\nPeer agents:\n${allPeers}\n`;
    prompt += `\nRULES:\n- Use blackboard tools (bb_propose, bb_bid, bb_award, bb_complete, bb_read) for task coordination\n`;
    prompt += `- Bid only on tasks matching your expertise with honest confidence scores\n`;
    prompt += `- Yield tasks to peers with higher confidence\n`;
    prompt += `- Complete awarded tasks promptly and report results via bb_complete\n`;
    prompt += `- You can also use spawn_subagent to directly delegate to any peer\n`;
  } else if (isP2POrchestrator && agentDef.role === "orchestrator") {
    const governance = systemConfig.system?.p2p_governance;
    const mechanism = governance?.consensus_mechanism || "contract_net";
    const bidderAgents = (systemConfig.agents || [])
      .filter((a: AgentConfig) => a.id !== agentDef.id && a.role !== "human" && a.p2p?.bidder === true)
      .map((a: AgentConfig) => `  - ${a.id} ("${a.name}", role: ${a.role})`)
      .join("\n");
    prompt += `P2P ORCHESTRATOR MODE:\n`;
    prompt += `You control the team via two strategies: direct delegation and P2P blackboard bidding.\n`;
    prompt += `Consensus mechanism: ${mechanism}\n`;
    prompt += `\nDirect downstream agents:\n${downstream.map(id => {
      const a = systemConfig.agents?.find((ag: AgentConfig) => ag.id === id);
      return a ? `  - ${a.id} ("${a.name}", role: ${a.role})` : `  - ${id}`;
    }).join("\n") || "  (none)"}\n`;
    prompt += `\nP2P Bidder agents:\n${bidderAgents || "  (none)"}\n`;
    prompt += `\nP2P BIDDING WORKFLOW:\n`;
    prompt += `  1. bb_propose("task description") — post the job on the blackboard (bidders are notified via bus)\n`;
    prompt += `  2. bb_read(task_id) — check for incoming bids\n`;
    prompt += `  3. bb_award(task_id, orchestrator_scores=[...]) — review bids via bb_read (includes bidder profiles). Provide YOUR score (0-1) for each bidder. Winner = 50% bidder confidence + 50% your score.\n`;
    prompt += `  4. spawn_subagent({agentId: "winner_id", task: "..."}) — SEND the task to the winner so they actually execute it\n`;
    prompt += `  5. Collect the result from spawn_subagent, then bb_complete if needed\n`;
    prompt += `\nRULES:\n- Use spawn_subagent for direct delegation to connected agents\n`;
    prompt += `- Use the P2P bidding workflow above when the best agent isn't clear\n`;
    prompt += `- IMPORTANT: After bb_award, you MUST spawn_subagent to the winner — the award alone does NOT send the task\n`;
    prompt += `- Mix both strategies as needed for optimal task routing\n`;
  } else if (isP2POrchestrator && agentDef.p2p?.bidder === true) {
    const governance = systemConfig.system?.p2p_governance;
    const mechanism = governance?.consensus_mechanism || "contract_net";
    prompt += `P2P ORCHESTRATOR MODE — BIDDER AGENT:\n`;
    prompt += `You receive tasks directly from the orchestrator and can bid on blackboard tasks.\n`;
    prompt += `Consensus mechanism: ${mechanism}\n`;
    if (agentDef.p2p?.confidence_domains?.length) {
      prompt += `Your expertise: ${agentDef.p2p.confidence_domains.join(", ")}\n`;
    }
    // Mesh-enabled bidder can delegate to other agents
    if (agentDef.mesh?.enabled === true) {
      const meshTargets = (systemConfig.agents || [])
        .filter((a: AgentConfig) => a.id !== agentDef.id && a.role !== "human")
        .map((a: AgentConfig) => `  - ${a.id} ("${a.name}", role: ${a.role})`)
        .join("\n");
      prompt += `\nMESH ENABLED — You can delegate sub-tasks to any agent using spawn_subagent:\n${meshTargets || "  (none)"}\n`;
      prompt += `Use this when a task requires expertise outside your domains — ask other agents for help.\n`;
    }
    prompt += `\nRULES:\n- Use blackboard tools (bb_read, bb_bid, bb_complete) to participate in P2P bidding\n`;
    prompt += `- Bid only on tasks matching your expertise with honest confidence scores\n`;
    prompt += `- Yield tasks to peers with higher confidence\n`;
    prompt += `- Complete awarded tasks promptly and report results via bb_complete\n`;
    prompt += `- Handle direct tasks from the orchestrator normally\n`;
    if (agentDef.mesh?.enabled === true) {
      prompt += `- When you need help, use spawn_subagent to delegate sub-tasks to other agents\n`;
    }
  } else if (downstream.length > 0) {
    const downstreamInfo = downstream.map(id => {
      const a = systemConfig.agents?.find((ag: AgentConfig) => ag.id === id);
      return a ? `  - ${a.id} ("${a.name}", role: ${a.role})` : `  - ${id}`;
    }).join("\n");
    prompt += `RULES:\n- Focus on your designated role and responsibilities\n- Be concise and efficient\n- Provide structured output suitable for downstream agents\n- Flag any issues or ambiguities clearly\n- You can ONLY spawn the following downstream agents (use agentId):\n${downstreamInfo}\n- Do NOT spawn agents outside this list.\n`;
  } else {
    prompt += `RULES:\n- Focus on your designated role and responsibilities\n- Be concise and efficient\n- Provide structured output suitable for downstream agents\n- Flag any issues or ambiguities clearly\n- You are a leaf agent — complete your assigned task directly. You cannot spawn sub-agents.\n`;
  }
  return prompt;
}

// --- Sub-agent spawning ---

// Active sub-agent tracking
interface SubagentRun {
  id: string;
  label: string;
  task: string;
  depth: number;
  status: "running" | "completed" | "error";
  startedAt: string;
  completedAt?: string;
  result?: string;
  toolCalls: string[];
}

const activeSubagents = new Map<string, SubagentRun>();

export function getActiveSubagents(): SubagentRun[] {
  return Array.from(activeSubagents.values());
}

// Sub-agent status broadcast callback (set by socket.ts)
let subagentStatusCallback: ((data: Record<string, any>) => void) | null = null;

export function setSubagentStatusCallback(cb: (data: Record<string, any>) => void) {
  subagentStatusCallback = cb;
}

// Import callTigerBotWithTools lazily to avoid circular dependency
let _callTigerBotForSubagent: typeof import("./tigerbot").callTigerBotWithTools | null = null;

async function getSubagentCaller() {
  if (!_callTigerBotForSubagent) {
    const mod = await import("./tigerbot");
    _callTigerBotForSubagent = mod.callTigerBotWithTools;
  }
  return _callTigerBotForSubagent;
}

export async function spawnSubagent(
  args: { task: string; label?: string; context?: string; agentId?: string },
  parentSessionId?: string,
  currentDepth: number = 0,
  signal?: AbortSignal,
): Promise<any> {
  const settings = await getSettings();
  if (!settings.subAgentEnabled) {
    return { ok: false, error: "Sub-agents are disabled. Enable them in Settings > Sub-Agent." };
  }

  const maxDepth = settings.subAgentMaxDepth || 2;

  // In manual mode: no depth limit — YAML structure is the boundary.
  // Validate that the calling agent is allowed to spawn the target agent
  // based on workflow outputs_to or connections.
  if (settings.subAgentMode === "manual" && settings.subAgentConfigFile) {
    const systemConfig = loadAgentConfig(settings.subAgentConfigFile);
    if (systemConfig) {
      const callerId = _currentAgentId;
      const targetId = args.agentId;

      if (!targetId) {
        return { ok: false, error: "In manual mode, agentId is required. You must spawn a specific agent defined in the architecture." };
      }

      // Check target agent exists in YAML
      const targetExists = systemConfig.agents?.some((a: AgentConfig) => a.id === targetId);
      if (!targetExists) {
        const available = systemConfig.agents?.map((a: AgentConfig) => a.id).join(", ") || "none";
        return { ok: false, error: `Agent "${targetId}" not found in architecture. Available agents: ${available}` };
      }

      // Validate caller is allowed to spawn target (via workflow outputs_to, connections, or mesh)
      if (callerId !== "main") {
        const callerDef = systemConfig.agents?.find((a: AgentConfig) => a.id === callerId);
        const callerHasMesh = callerDef?.mesh?.enabled === true;
        const isGlobalMesh = systemConfig.system?.orchestration_mode === "mesh";
        const isP2PMode = systemConfig.system?.orchestration_mode === "p2p";

        if (!callerHasMesh && !isGlobalMesh && !isP2PMode) {
          const callerStep = systemConfig.workflow?.sequence?.find((s: any) => s.agent === callerId);
          const allowedTargets: string[] = callerStep?.outputs_to || [];

          // Also check connections
          const connTargets = (systemConfig.connections || [])
            .filter((c: any) => c.from === callerId)
            .map((c: any) => c.to);
          const allAllowed = [...new Set([...allowedTargets, ...connTargets])];

          if (!allAllowed.includes(targetId)) {
            return { ok: false, error: `Agent "${callerId}" is not allowed to spawn "${targetId}". Allowed targets: ${allAllowed.join(", ") || "none"}` };
          }
        }
      }
    }
  } else {
    // Auto mode: enforce depth limit
    if (currentDepth >= maxDepth) {
      return { ok: false, error: `Sub-agent depth limit reached (max ${maxDepth}). Cannot spawn deeper.` };
    }
  }

  // Check concurrent limit
  const maxConcurrent = settings.subAgentMaxConcurrent || 3;
  const runningCount = Array.from(activeSubagents.values()).filter(s => s.status === "running").length;
  if (runningCount >= maxConcurrent) {
    return { ok: false, error: `Too many concurrent sub-agents (${runningCount}/${maxConcurrent}). Wait for one to finish.` };
  }

  const agentId = args.agentId || `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const subagentId = agentId;
  const label = args.label || "subagent";
  const timeout = (settings.subAgentTimeout || 120) * 1000; // default 120s

  const run: SubagentRun = {
    id: subagentId,
    label,
    task: args.task,
    depth: currentDepth + 1,
    status: "running",
    startedAt: new Date().toISOString(),
    toolCalls: [],
  };
  activeSubagents.set(subagentId, run);

  // Persist spawn start to agent history
  if (parentSessionId) {
    appendAgentHistory(parentSessionId, "spawn.jsonl", {
      id: subagentId, label, task: args.task.slice(0, 2000), depth: currentDepth + 1,
      status: "running", startedAt: run.startedAt,
    }).catch(() => {});
  }

  // Broadcast sub-agent spawn status
  if (subagentStatusCallback) {
    subagentStatusCallback({
      sessionId: parentSessionId,
      status: "subagent_spawn",
      subagentId,
      label,
      task: args.task.slice(0, 200),
      depth: currentDepth + 1,
    });
  }

  console.log(`[SubAgent:${label}] Spawned at depth ${currentDepth + 1}. Task: ${args.task.slice(0, 200)}`);

  // Build sub-agent system prompt — check for manual YAML config
  let subPrompt: string;
  const subModel = settings.subAgentModel || undefined;
  let resolvedAgentDef: AgentConfig | null = null;
  let resolvedConnections: any[] | undefined;
  let resolvedSystemConfig: AgentSystemConfig | null = null;

  if (settings.subAgentMode === "manual" && settings.subAgentConfigFile) {
    // Load agent definition from YAML config
    const systemConfig = loadAgentConfig(settings.subAgentConfigFile);
    const agentDef = systemConfig?.agents?.find((a: AgentConfig) =>
      a.id === args.agentId || a.id === label || a.name === label
    );
    resolvedConnections = systemConfig?.connections;
    resolvedSystemConfig = systemConfig;

    if (agentDef && systemConfig) {
      resolvedAgentDef = agentDef;
      subPrompt = getManualAgentPrompt(agentDef, systemConfig);
      subPrompt += `\nYOUR TASK:\n${args.task}\n`;
      if (args.context) subPrompt += `\nADDITIONAL CONTEXT:\n${args.context}\n`;
      subPrompt += `\nYou are sub-agent "${label}" at depth ${currentDepth + 1}/${maxDepth}.`;
    } else {
      // Fallback to auto mode if agent not found in config
      subPrompt = `You are a focused sub-agent. You have been spawned by a parent agent to complete a specific task.

YOUR TASK:
${args.task}

${args.context ? `ADDITIONAL CONTEXT:\n${args.context}\n` : ""}

RULES:
- Focus ONLY on completing the assigned task
- Be concise and efficient — minimize unnecessary tool calls
- Return your findings/results clearly so the parent agent can use them
- You have full access to tools (web search, file read/write, Python, shell, etc.)
- Do NOT ask follow-up questions — work with what you have
- If the task is ambiguous, make reasonable assumptions and proceed
- When done, provide a clear summary of what you accomplished

You are sub-agent "${label}" at depth ${currentDepth + 1}/${maxDepth}.`;
    }
  } else {
    subPrompt = `You are a focused sub-agent. You have been spawned by a parent agent to complete a specific task.

YOUR TASK:
${args.task}

${args.context ? `ADDITIONAL CONTEXT:\n${args.context}\n` : ""}

RULES:
- Focus ONLY on completing the assigned task
- Be concise and efficient — minimize unnecessary tool calls
- Return your findings/results clearly so the parent agent can use them
- You have full access to tools (web search, file read/write, Python, shell, etc.)
- Do NOT ask follow-up questions — work with what you have
- If the task is ambiguous, make reasonable assumptions and proceed
- When done, provide a clear summary of what you accomplished

You are sub-agent "${label}" at depth ${currentDepth + 1}/${maxDepth}.`;
  }

  // Append protocol instructions based on agent's actual config
  const agentProtoTools = getProtocolToolsForAgent(resolvedAgentDef, resolvedConnections, resolvedSystemConfig);
  const protoNames = agentProtoTools.map((t: any) => t.function.name);
  const hasProto = protoNames.length > 0;

  if (hasProto) {
    const protoLines: string[] = [];
    if (protoNames.some((n: string) => n.startsWith("proto_tcp"))) {
      protoLines.push("- TCP (proto_tcp_send / proto_tcp_read): Point-to-point messaging with a specific agent");
    }
    if (protoNames.some((n: string) => n.startsWith("proto_bus"))) {
      const topicHint = resolvedAgentDef?.bus?.topics?.length
        ? ` Your configured topics: ${resolvedAgentDef.bus.topics.join(", ")}`
        : "";
      protoLines.push(`- Bus (proto_bus_publish / proto_bus_history): Broadcast messages to all bus-connected agents on a topic.${topicHint}`);
    }
    if (protoNames.some((n: string) => n.startsWith("proto_queue"))) {
      protoLines.push("- Queue (proto_queue_send / proto_queue_receive / proto_queue_peek): FIFO message queue to another agent");
    }
    subPrompt += `\n\nCOMMUNICATION PROTOCOLS:\nYour agent ID is "${agentId}".\n${protoLines.join("\n")}\nUse these to coordinate with peer agents when your task requires collaboration.`;
  } else {
    subPrompt += `\n\nYour agent ID is "${agentId}". You have no inter-agent communication protocols configured.`;
  }

  // Error recovery instructions for all sub-agents
  subPrompt += `\n\nERROR RECOVERY: If a tool call fails (Python error, missing package, file not found), do NOT give up. Analyze the error, fix the issue (install packages, correct paths, fix syntax), and retry. If the same approach fails twice, try a different method. Always complete the task.`;

  // Set agent context so protocol tools know who we are — preserve project folder
  const prevAgentId = _currentAgentId;
  const prevProjectFolder = _currentProjectWorkingFolder;
  const subTaskId = `subagent-${agentId}-${Date.now()}`;
  setCallContext(subTaskId, parentSessionId, currentDepth + 1, agentId, _currentProjectWorkingFolder);

  try {
    const callAgent = await getSubagentCaller();

    // Create abort with timeout
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    // Combine parent signal and timeout
    const combinedSignal = signal && typeof (AbortSignal as any).any === "function"
      ? (AbortSignal as any).any([signal, timeoutController.signal])
      : timeoutController.signal;

    // Build filtered tool set for this sub-agent
    const subagentTools = await getToolsForSubagent(currentDepth + 1, resolvedAgentDef, resolvedConnections, resolvedSystemConfig);

    // Use agent-specific model if defined, fall back to system sub-agent model override
    const agentModel = resolvedAgentDef?.model || subModel || undefined;

    let result: any;

    if (isLocalCliAgent(agentModel)) {
      // --- Local CLI agent (Claude Code or Codex): bypass LLM tool loop ---
      const isCodex = isCodexModel(agentModel);
      const cliName = isCodex ? "Codex" : "Claude Code";
      const runAgent = isCodex ? runCodexAgent : runClaudeCodeAgent;
      const cliSubModel = extractCliSubModel(agentModel);
      console.log(`[SubAgent:${label}] Using ${cliName} CLI as agent backend${cliSubModel ? ` (model: ${cliSubModel})` : ""}`);
      result = await runAgent(args.task, {
        workingDir: _currentProjectWorkingFolder || settings.sandboxDir,
        systemPrompt: subPrompt,
        signal: combinedSignal,
        timeout,
        ...(isCodex ? {} : { maxTurns: settings.agentMaxToolRounds || 15 }),
        model: cliSubModel,
        onToolCall: (name: string, toolArgs: any) => {
          run.toolCalls.push(name);
          console.log(`[SubAgent:${label}] ${cliName} Tool: ${name}`);
          if (subagentStatusCallback) {
            subagentStatusCallback({
              sessionId: parentSessionId,
              status: "subagent_tool",
              subagentId,
              label,
              tool: name,
            });
          }
        },
      });
    } else {
      // --- Standard LLM API agent ---
      result = await callAgent(
        [{ role: "user" as const, content: args.task }],
        subPrompt,
        // onToolCall
        (name: string, toolArgs: any) => {
          run.toolCalls.push(name);
          console.log(`[SubAgent:${label}] Tool: ${name}`);
          if (subagentStatusCallback) {
            subagentStatusCallback({
              sessionId: parentSessionId,
              status: "subagent_tool",
              subagentId,
              label,
              tool: name,
            });
          }
        },
        // onToolResult
        (name: string, toolResult: any) => {
          if (subagentStatusCallback) {
            subagentStatusCallback({
              sessionId: parentSessionId,
              status: "subagent_tool_done",
              subagentId,
              label,
              tool: name,
            });
          }
        },
        combinedSignal,
        subagentTools,
        agentModel,
      );
    }

    clearTimeout(timeoutId);
    clearCallContext(subTaskId);
    // Restore parent agent context globals
    _currentAgentId = prevAgentId;
    _currentProjectWorkingFolder = prevProjectFolder;
    _currentSubagentDepth = currentDepth;

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.result = result.content?.slice(0, 5000);

    // Persist spawn completion to agent history
    if (parentSessionId) {
      appendAgentHistory(parentSessionId, "spawn.jsonl", {
        id: subagentId, label, status: "completed", completedAt: run.completedAt,
        result: run.result, toolCallCount: run.toolCalls.length,
      }).catch(() => {});
    }

    console.log(`[SubAgent:${label}] Completed. ${run.toolCalls.length} tool calls.`);

    // Broadcast completion
    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId: parentSessionId,
        status: "subagent_done",
        subagentId,
        label,
      });
    }

    // Clean up after a delay
    setTimeout(() => activeSubagents.delete(subagentId), 60000);

    return {
      ok: true,
      subagentId,
      label,
      result: result.content,
      toolCalls: run.toolCalls,
      outputFiles: result.toolResults?.flatMap((tr: any) => tr.result?.outputFiles || []) || [],
    };
  } catch (err: any) {
    clearCallContext(subTaskId);
    // Restore parent agent context globals
    _currentAgentId = prevAgentId;
    _currentProjectWorkingFolder = prevProjectFolder;
    _currentSubagentDepth = currentDepth;
    run.status = "error";
    run.completedAt = new Date().toISOString();

    // Persist spawn error to agent history
    if (parentSessionId) {
      appendAgentHistory(parentSessionId, "spawn.jsonl", {
        id: subagentId, label, status: "error", completedAt: run.completedAt,
        error: err.message,
      }).catch(() => {});
    }

    console.error(`[SubAgent:${label}] Error: ${err.message}`);

    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId: parentSessionId,
        status: "subagent_error",
        subagentId,
        label,
        error: err.message,
      });
    }

    setTimeout(() => activeSubagents.delete(subagentId), 30000);

    return {
      ok: false,
      subagentId,
      label,
      error: err.name === "AbortError" ? "Sub-agent timed out" : err.message,
      toolCalls: run.toolCalls,
    };
  }
}

// ─── Realtime Agent System ───
// All agents from YAML boot at session start, stay alive, communicate via bus.

// --- Tool definitions for realtime mode ---

const sendTaskTool = {
  type: "function" as const,
  function: {
    name: "send_task",
    description: "Send a task to an agent in the realtime session. The agent is already alive and will process the task immediately. You can send tasks to multiple agents in one response for parallel execution.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target agent ID (e.g. 'agent_2')" },
        task: { type: "string", description: "Task description for the agent" },
        context: { type: "string", description: "Additional context or data" },
        wait: { type: "boolean", description: "If true, block until the agent finishes and return the result inline (default: false)" },
      },
      required: ["to", "task"],
    },
  },
};

const waitResultTool = {
  type: "function" as const,
  function: {
    name: "wait_result",
    description: "Wait for a result from an agent that was previously given a task via send_task. Blocks until the agent publishes its result.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Agent ID to wait for result from" },
        timeout: { type: "number", description: "Max seconds to wait (default: uses session timeout)" },
      },
      required: ["from"],
    },
  },
};

const checkAgentsTool = {
  type: "function" as const,
  function: {
    name: "check_agents",
    description: "Check the status of all agents in the realtime session. Shows which agents are idle, working, or completed.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// --- Realtime Session tracking ---

interface RealtimeAgentHandle {
  agentDef: AgentConfig;
  promise: Promise<void>;
  status: "idle" | "working" | "completed" | "error";
  lastTask?: string;
  lastResult?: string;
}

interface RealtimeSession {
  sessionId: string;
  agents: Map<string, RealtimeAgentHandle>;
  abortController: AbortController;
  systemConfig: AgentSystemConfig;
}

const realtimeSessions = new Map<string, RealtimeSession>();

export function getRealtimeSession(sessionId: string): RealtimeSession | undefined {
  return realtimeSessions.get(sessionId);
}

// --- Boot all agents ---

export async function startRealtimeSession(
  sessionId: string,
  configFile: string,
  signal?: AbortSignal,
): Promise<RealtimeSession | null> {
  const settings = await getSettings();
  const systemConfig = loadAgentConfig(configFile);
  if (!systemConfig) {
    console.error("[Realtime] Failed to load agent config:", configFile);
    return null;
  }

  // If session already exists, return it
  if (realtimeSessions.has(sessionId)) {
    return realtimeSessions.get(sessionId)!;
  }

  const abortController = new AbortController();
  // Link parent signal
  if (signal) {
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const session: RealtimeSession = {
    sessionId,
    agents: new Map(),
    abortController,
    systemConfig,
  };

  console.log(`[Realtime] Starting session ${sessionId} with ${systemConfig.agents.length} agents`);

  // Reload saved bus history from previous session runs (if any)
  const loadedCount = await busLoadHistory(sessionId);
  if (loadedCount > 0) {
    console.log(`[Realtime] Loaded ${loadedCount} saved bus messages for session ${sessionId}`);
  }

  // Boot each agent concurrently (skip human nodes — they are entry points)
  for (const agentDef of systemConfig.agents) {
    const handle: RealtimeAgentHandle = {
      agentDef,
      status: agentDef.role === "human" ? "idle" : "idle",
      promise: Promise.resolve(),
    };

    // Human nodes don't get an LLM loop — they represent the real user
    if (agentDef.role !== "human") {
      handle.promise = realtimeAgentLoop(
        agentDef,
        sessionId,
        systemConfig,
        abortController.signal,
        handle,
      );
    } else {
      // Start a listener loop for the human node that forwards agent results to the client
      handle.promise = humanNodeLoop(agentDef, sessionId, abortController.signal);
    }

    session.agents.set(agentDef.id, handle);

    // Broadcast agent ready
    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId,
        status: "realtime_agent_ready",
        agentId: agentDef.id,
        label: agentDef.name,
        role: agentDef.role,
      });
    }
  }

  realtimeSessions.set(sessionId, session);
  console.log(`[Realtime] All ${systemConfig.agents.length} agents alive and listening`);
  return session;
}

// --- Shutdown ---

export function shutdownRealtimeSession(sessionId: string): void {
  const session = realtimeSessions.get(sessionId);
  if (!session) return;

  console.log(`[Realtime] Shutting down session ${sessionId}`);
  // Flush any buffered agent history before cleanup
  flushAgentHistory(sessionId).catch(() => {});
  session.abortController.abort();
  realtimeSessions.delete(sessionId);
  cleanupSessionProtocols(sessionId);
}

// --- Agent event loop ---

async function realtimeAgentLoop(
  agentDef: AgentConfig,
  sessionId: string,
  systemConfig: AgentSystemConfig,
  signal: AbortSignal,
  handle: RealtimeAgentHandle,
): Promise<void> {
  const agentId = agentDef.id;
  const settings = await getSettings();

  // Build system prompt from YAML
  let systemPrompt = getManualAgentPrompt(agentDef, systemConfig);
  systemPrompt += `\nYou are agent "${agentDef.name}" (ID: ${agentId}) in a REALTIME multi-agent session.`;
  systemPrompt += `\nYou receive tasks automatically. Complete each task using your tools — your result is sent back automatically when you finish.`;
  systemPrompt += `\nIMPORTANT: Do NOT use proto_tcp_send or proto_bus_publish to assign tasks to other agents. If you need to delegate, use send_task (if available). Protocol tools are only for exchanging data/status, NOT for task assignment.`;
  systemPrompt += `\nYour agent ID is "${agentId}".`;
  systemPrompt += `\n\nERROR RECOVERY: If a tool call fails (e.g. Python error, missing package, file not found), you MUST NOT give up. Instead:`;
  systemPrompt += `\n1. Analyze the error message carefully`;
  systemPrompt += `\n2. Fix the issue (install missing packages, correct file paths, fix syntax)`;
  systemPrompt += `\n3. Try again with a corrected approach`;
  systemPrompt += `\n4. If the same approach fails twice, try a completely different method`;
  systemPrompt += `\nNever stop working due to a tool error — always find a way to complete the task.`;

  // Protocol instructions
  const agentProtoTools = getProtocolToolsForAgent(agentDef, systemConfig.connections, systemConfig);
  const protoNames = agentProtoTools.map((t: any) => t.function.name);
  if (protoNames.length > 0) {
    const protoLines: string[] = [];
    if (protoNames.some((n: string) => n.startsWith("proto_tcp"))) {
      protoLines.push("- TCP (proto_tcp_send / proto_tcp_read): Point-to-point messaging with a specific agent");
    }
    if (protoNames.some((n: string) => n.startsWith("proto_bus"))) {
      protoLines.push("- Bus (proto_bus_publish / proto_bus_history): Broadcast on the shared bus");
    }
    if (protoNames.some((n: string) => n.startsWith("proto_queue"))) {
      protoLines.push("- Queue (proto_queue_send / proto_queue_receive): FIFO messaging");
    }
    systemPrompt += `\n\nCOMMUNICATION PROTOCOLS:\n${protoLines.join("\n")}`;
  }

  // Build tool set: builtin tools + protocol tools
  // Orchestrator agents should DELEGATE work, not do research themselves.
  // Only give orchestrators file I/O, code execution, and skill tools — remove web_search, fetch_url, etc.
  const orchestratorOnlyTools = ["write_file", "read_file", "list_files", "run_python", "run_react", "list_skills", "load_skill"];
  const isOrchRole = agentDef.role === "orchestrator";
  const agentTools: any[] = isOrchRole
    ? builtinTools.filter((t: any) => orchestratorOnlyTools.includes(t.function?.name || ""))
    : [...builtinTools];
  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    agentTools.push(openRouterSearchTool);
  }
  // If this agent has downstream connections, mesh enabled, or global mesh mode — give it send_task + wait_result
  const orchMode = systemConfig.system?.orchestration_mode;
  const isGlobalMesh = orchMode === "mesh";
  const isHybrid = orchMode === "hybrid";
  const isP2P = orchMode === "p2p";
  const isP2POrchestrator = orchMode === "p2p_orchestrator";
  const agentMeshEnabled = agentDef.mesh?.enabled === true;
  const hasMesh = isGlobalMesh || agentMeshEnabled;

  const workflowStep = systemConfig.workflow?.sequence?.find((s: any) => s.agent === agentId);
  const outputsTo: string[] = workflowStep?.outputs_to || [];
  const connTargets = (systemConfig.connections || [])
    .filter((c: any) => c.from === agentId)
    .map((c: any) => c.to);
  const downstream = [...new Set([...outputsTo, ...connTargets])];

  const allPeers = (systemConfig.agents || [])
    .filter((a: AgentConfig) => a.id !== agentId && a.role !== "human")
    .map((a: AgentConfig) => a.id);

  const meshPeers = (systemConfig.agents || [])
    .filter((a: AgentConfig) => a.id !== agentId && a.role !== "human" && a.mesh?.enabled === true)
    .map((a: AgentConfig) => a.id);

  if (isP2P) {
    // P2P Swarm: all agents are autonomous peers using blackboard for coordination
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    agentTools.push(...blackboardTools);
    const governance = systemConfig.system?.p2p_governance;
    const mechanism = governance?.consensus_mechanism || "contract_net";
    systemPrompt += `\n\nPEER-TO-PEER SWARM MODE: You are an autonomous peer agent in a flat P2P swarm. No agent holds persistent authority.`;
    systemPrompt += `\nPeer agents: ${allPeers.join(", ")}`;
    systemPrompt += `\nConsensus mechanism: ${mechanism}`;
    if (agentDef.p2p?.confidence_domains?.length) {
      systemPrompt += `\nYour expertise domains: ${agentDef.p2p.confidence_domains.join(", ")}`;
    }
    systemPrompt += `\n\nCOORDINATION PROTOCOL (Contract Net Protocol):`;
    systemPrompt += `\n  1. PROPOSE: Use bb_propose to post work on the blackboard (all peers are notified via bus topic "bb:new_task")`;
    systemPrompt += `\n  2. BID: When you see a "bb:new_task" bus message or open tasks via bb_read, use bb_bid with your confidence score`;
    systemPrompt += `\n  3. AWARD: The proposer calls bb_award — highest-confidence bidder wins`;
    systemPrompt += `\n  4. SEND: After awarding, the proposer MUST send_task to the winner to actually deliver the work`;
    systemPrompt += `\n  5. EXECUTE: The winning agent executes the task using available tools`;
    systemPrompt += `\n  6. COMPLETE: Report results via bb_complete AND reply to the proposer`;
    systemPrompt += `\n\nBLACKBOARD: Use bb_read to check for open tasks. Use bb_log to review the audit trail.`;
    systemPrompt += `\nBUS NOTIFICATIONS: Watch for "bb:new_task" (new proposals) and "bb:task_awarded" (award results) on the bus.`;
    systemPrompt += `\nYou can also use send_task for direct peer-to-peer delegation when you already know who should handle something.`;
    systemPrompt += `\n\nRULES:`;
    systemPrompt += `\n  - Only bid on tasks you are confident you can complete well`;
    systemPrompt += `\n  - Yield tasks to peers with higher confidence scores`;
    systemPrompt += `\n  - Avoid livelock: if you've been negotiating for too long, accept the current best bid`;
    systemPrompt += `\n  - Complete your awarded tasks promptly and report results`;
    systemPrompt += `\n  - Do NOT loop indefinitely — complete your part and report back`;
  } else if (isP2POrchestrator && agentDef.role === "orchestrator") {
    // P2P Orchestrator: controls hierarchical flow + can post jobs to blackboard for P2P bidding
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    agentTools.push(...blackboardTools);
    const governance = systemConfig.system?.p2p_governance;
    const mechanism = governance?.consensus_mechanism || "contract_net";
    const bidderAgents = (systemConfig.agents || [])
      .filter((a: AgentConfig) => a.id !== agentId && a.role !== "human" && a.p2p?.bidder === true)
      .map((a: AgentConfig) => a.id);
    // Separate bidders that are NOT in downstream (must use blackboard) from those that are (can use direct)
    const directAgents = downstream.filter(id => !bidderAgents.includes(id));
    const bidOnlyAgents = bidderAgents.filter(id => !downstream.includes(id));
    const bidAndDirect = bidderAgents.filter(id => downstream.includes(id));

    systemPrompt += `\n\nP2P ORCHESTRATOR MODE: You control the team and coordinate all work.`;

    if (directAgents.length > 0 || bidAndDirect.length > 0) {
      systemPrompt += `\n\n  STRATEGY 1 — DIRECT DELEGATION:`;
      systemPrompt += `\n  Use send_task to assign work to your CONNECTED downstream agents: ${[...directAgents, ...bidAndDirect].join(", ")}`;
      systemPrompt += `\n  Use this for agents you have a direct connection to.`;
    }

    if (bidOnlyAgents.length > 0) {
      systemPrompt += `\n\n  STRATEGY 2 — P2P BIDDING (Blackboard) — REQUIRED for these agents:`;
      systemPrompt += `\n  You have NO direct connection to these bidder agents: ${bidOnlyAgents.join(", ")}`;
      systemPrompt += `\n  You MUST use the blackboard bidding workflow to assign tasks to them.`;
      systemPrompt += `\n  Do NOT use send_task directly to bidder agents — they can only receive work through bidding.`;
    } else {
      systemPrompt += `\n\n  STRATEGY 2 — P2P BIDDING (Blackboard) — Optional:`;
      systemPrompt += `\n  All bidder agents are also directly connected, so bidding is optional.`;
    }
    systemPrompt += `\n  P2P bidder agents: ${bidderAgents.join(", ") || "(none)"}`;
    systemPrompt += `\n  Consensus mechanism: ${mechanism}`;
    systemPrompt += `\n\n  P2P BIDDING WORKFLOW:`;
    systemPrompt += `\n    1. bb_propose("task description") — post the job. Bidder agents are AUTOMATICALLY woken up and asked to bid.`;
    systemPrompt += `\n    2. Use bb_read to check for bids. Bidders need time to respond — if no bids yet, call bb_read again after a moment.`;
    systemPrompt += `\n    3. bb_award(task_id, orchestrator_scores=[{agent_id, score, reason}, ...]) — review bids via bb_read (includes bidder profiles: persona, expertise, reputation). Then provide YOUR score (0-1) for each bidder. Final winner = 50% bidder confidence + 50% your score. Example: orchestrator_scores=[{agent_id:"web_researcher_1", score:0.9, reason:"best fit for data tasks"}, ...]`;
    systemPrompt += `\n    4. send_task({to: "winner_id", task: "full task details"}) — SEND the actual task to the winner`;
    systemPrompt += `\n    5. wait_result({from: "winner_id"}) — collect the result`;
    systemPrompt += `\n    IMPORTANT: After bb_award, you MUST send_task to the winner — the award alone does NOT execute the task.`;
    systemPrompt += `\n    IMPORTANT: Do NOT skip bidding. Do NOT do the work yourself. Post tasks, wait for bids, award, then send_task.`;

    if (bidOnlyAgents.length > 0) {
      systemPrompt += `\n\n  CRITICAL: Agents ${bidOnlyAgents.join(", ")} are ONLY reachable via blackboard bidding. Do NOT send_task to them without first going through bb_propose → bb_award.`;
    }
    systemPrompt += `\nFor DIRECT agents: send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}).`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution.`;
  } else if (isP2POrchestrator && agentDef.p2p?.bidder === true) {
    // P2P Bidder agent in p2p_orchestrator mode: can bid on blackboard tasks + receive direct tasks
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    agentTools.push(...blackboardTools);
    const governance = systemConfig.system?.p2p_governance;
    const mechanism = governance?.consensus_mechanism || "contract_net";
    systemPrompt += `\n\nP2P ORCHESTRATOR MODE — BIDDER AGENT: You are a P2P bidder in this system.`;
    systemPrompt += `\nYou can receive tasks in TWO ways:`;
    systemPrompt += `\n  1. DIRECT: The orchestrator sends you tasks via send_task (you receive and execute)`;
    systemPrompt += `\n  2. BIDDING: You monitor the blackboard for open tasks and bid on ones matching your expertise`;
    systemPrompt += `\nConsensus mechanism: ${mechanism}`;
    if (agentDef.p2p?.confidence_domains?.length) {
      systemPrompt += `\nYour expertise domains: ${agentDef.p2p.confidence_domains.join(", ")}`;
    }
    systemPrompt += `\n\nBIDDING PROTOCOL:`;
    systemPrompt += `\n  When you receive a task that mentions "blackboard" and "bb_bid" — this is a BID REQUEST, not a real task:`;
    systemPrompt += `\n  1. Use bb_read to review the open task on the blackboard`;
    systemPrompt += `\n  2. Use bb_bid(task_id, confidence) to submit your bid — pick a confidence score (0-1) based on how well the task matches your expertise`;
    systemPrompt += `\n  3. STOP — do NOT execute the task. Just bid and finish. The orchestrator will award and send the real task later.`;
    systemPrompt += `\n\n  When you receive a REAL task (after being awarded via bb_award):`;
    systemPrompt += `\n  1. Execute the task using your available tools`;
    systemPrompt += `\n  2. Report completion via bb_complete(task_id, result)`;
    systemPrompt += `\n\nRULES:`;
    systemPrompt += `\n  - Only bid on tasks you are confident you can complete well`;
    systemPrompt += `\n  - Yield tasks to peers with higher confidence scores`;
    systemPrompt += `\n  - Complete your awarded tasks promptly and report results`;
    systemPrompt += `\n  - You can also receive direct tasks from the orchestrator — handle those normally`;
    if (downstream.length > 0) {
      systemPrompt += `\nYour downstream agents (for sub-delegation): ${downstream.join(", ")}`;
    }
  } else if (isHybrid && agentDef.role === "orchestrator") {
    // Hybrid orchestrator: controls flow via connections, monitors bus, can stop mesh agents
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    systemPrompt += `\n\nHYBRID MODE (ORCHESTRATOR): You control the team and coordinate all work.`;
    systemPrompt += `\nYour connected agents: ${downstream.join(", ")}`;
    if (meshPeers.length > 0) {
      systemPrompt += `\nMesh-enabled agents (can collaborate freely): ${meshPeers.join(", ")}`;
    }
    systemPrompt += `\nYou can see all bus messages to monitor agent activity.`;
    systemPrompt += `\nYou are responsible for:`;
    systemPrompt += `\n  1. Delegating tasks to your connected agents via send_task`;
    systemPrompt += `\n  2. Monitoring mesh agents' progress via check_agents and bus messages`;
    systemPrompt += `\n  3. Collecting results via wait_result and synthesizing the final output`;
    systemPrompt += `\n  4. Ensuring work completes — if mesh agents loop or stall, reassign the task or provide direction`;
    systemPrompt += `\nUse send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}) to collect results.`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution.`;
  } else if (hasMesh) {
    // Mesh: agent can send tasks to any other agent
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    if (isHybrid) {
      systemPrompt += `\n\nHYBRID MESH AGENT: You can collaborate with any peer agent, but the orchestrator coordinates the overall task.`;
      systemPrompt += `\nAvailable peers: ${allPeers.join(", ")}`;
      systemPrompt += `\nIMPORTANT: When your work is done, send your result back to the agent that assigned you the task. Do NOT loop indefinitely — complete your part and report back.`;
    } else {
      systemPrompt += `\n\nMESH: You can send tasks to any agent using send_task and wait_result.`;
      systemPrompt += `\nAvailable agents: ${allPeers.join(", ")}`;
    }
    if (downstream.length > 0) {
      systemPrompt += `\nYour primary downstream agents: ${downstream.join(", ")}`;
    }
    systemPrompt += `\nUse send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}) to collect results.`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution. Do NOT use proto_tcp_send or proto_bus_publish to assign tasks — use send_task instead.`;
  } else if (downstream.length > 0) {
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    systemPrompt += `\n\nDELEGATION: You can delegate tasks to downstream agents using send_task and wait_result.`;
    systemPrompt += `\nYour downstream agents: ${downstream.join(", ")}`;
    systemPrompt += `\nUse send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}) to collect results.`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution. Do NOT use proto_tcp_send or proto_bus_publish to assign tasks — use send_task instead.`;
  }
  agentTools.push(...agentProtoTools);
  // Deduplicate tools by function name (e.g. blackboard tools may come from both proto and P2P paths)
  const seenToolNames = new Set<string>();
  const dedupedTools: any[] = [];
  for (const t of [...agentTools, ...getMcpTools()]) {
    const name = t.function?.name || "";
    if (name && seenToolNames.has(name)) continue;
    if (name) seenToolNames.add(name);
    dedupedTools.push(t);
  }
  const finalTools = dedupedTools;

  console.log(`[Realtime:${agentDef.name}] Agent loop started, waiting for tasks...`);

  // Event loop: wait for task → execute → publish result → repeat
  while (!signal.aborted) {
    try {
      handle.status = "idle";

      // Wait for a task message on bus topic "task:{agentId}"
      const msg = await busWaitForMessage(sessionId, `task:${agentId}`, 0, signal);

      handle.status = "working";
      const taskText = msg.payload?.task || "(no task)";
      handle.lastTask = taskText;

      console.log(`[Realtime:${agentDef.name}] Received task: ${taskText.slice(0, 200)}`);

      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "realtime_agent_working",
          agentId,
          label: agentDef.name,
          task: taskText.slice(0, 200),
        });
      }

      // Set call context so protocol tools know who we are — preserve project folder
      const prevAgentId = _currentAgentId;
      const prevProjectFolder = _currentProjectWorkingFolder;
      const rtTaskId = `realtime-${agentId}-${Date.now()}`;
      setCallContext(rtTaskId, sessionId, 0, agentId, _currentProjectWorkingFolder);

      // Run LLM tool loop for this task
      const taskPrompt = `${systemPrompt}\n\nYOUR TASK:\n${msg.payload.task}${msg.payload.context ? `\n\nADDITIONAL CONTEXT:\n${msg.payload.context}` : ""}`;

      // Use agent-specific model from YAML definition if set
      const realtimeAgentModel = agentDef.model || undefined;

      let result: any;

      if (isLocalCliAgent(realtimeAgentModel)) {
        // --- Local CLI agent (Claude Code or Codex): autonomous with own tool loop ---
        const isCodex = isCodexModel(realtimeAgentModel);
        const cliName = isCodex ? "Codex" : "Claude Code";
        const runAgent = isCodex ? runCodexAgent : runClaudeCodeAgent;
        const rtCliSubModel = extractCliSubModel(realtimeAgentModel);
        console.log(`[Realtime:${agentDef.name}] Using ${cliName} CLI as agent backend${rtCliSubModel ? ` (model: ${rtCliSubModel})` : ""}`);
        result = await runAgent(msg.payload.task, {
          workingDir: _currentProjectWorkingFolder || settings.sandboxDir,
          systemPrompt: taskPrompt,
          signal,
          timeout: (settings.subAgentTimeout || 120) * 1000,
          ...(isCodex ? {} : { maxTurns: settings.agentMaxToolRounds || 15 }),
          model: rtCliSubModel,
          onToolCall: (name: string, toolArgs: any) => {
            console.log(`[Realtime:${agentDef.name}] ${cliName} Tool: ${name}`);
            if (subagentStatusCallback) {
              subagentStatusCallback({
                sessionId,
                status: "realtime_agent_tool",
                agentId,
                label: agentDef.name,
                tool: name,
              });
            }
          },
        });
      } else {
        // --- Standard LLM API agent ---
        const callAgent = await getSubagentCaller();
        result = await callAgent(
          [{ role: "user" as const, content: msg.payload.task }],
          taskPrompt,
          (name: string, toolArgs: any) => {
            console.log(`[Realtime:${agentDef.name}] Tool: ${name}`);
            if (subagentStatusCallback) {
              subagentStatusCallback({
                sessionId,
                status: "realtime_agent_tool",
                agentId,
                label: agentDef.name,
                tool: name,
              });
            }
          },
          (name: string, toolResult: any) => {
            if (subagentStatusCallback) {
              subagentStatusCallback({
                sessionId,
                status: "realtime_agent_tool_done",
                agentId,
                label: agentDef.name,
                tool: name,
              });
            }
          },
          signal,
          finalTools,
          realtimeAgentModel,
          undefined,  // sessionId (for checkpoint)
          undefined,  // onRetry
          rtTaskId,   // taskId — so callTool resolves the correct call context
        );
      }

      // Restore context
      clearCallContext(rtTaskId);
      _currentAgentId = prevAgentId;
      _currentProjectWorkingFolder = prevProjectFolder;

      const resultContent = result.content || "(no result)";
      handle.lastResult = resultContent.slice(0, 5000);
      handle.status = "idle";

      // Collect output files from tool results
      const agentOutputFiles: string[] = result.toolResults?.flatMap((tr: any) => tr.result?.outputFiles || []) || [];

      console.log(`[Realtime:${agentDef.name}] Task completed. Result: ${resultContent.slice(0, 200)}${agentOutputFiles.length > 0 ? ` (${agentOutputFiles.length} files)` : ""}`);

      // Publish result to bus
      busPublish(sessionId, agentId, `result:${agentId}`, {
        result: resultContent,
        outputFiles: agentOutputFiles,
      });

      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "realtime_agent_done",
          agentId,
          label: agentDef.name,
        });
      }

    } catch (err: any) {
      if (err.message === "aborted" || signal.aborted) {
        console.log(`[Realtime:${agentDef.name}] Agent loop ended (shutdown)`);
        break;
      }
      console.error(`[Realtime:${agentDef.name}] Error:`, err.message);
      handle.status = "error";

      // Notify client about the error and recovery
      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "realtime_agent_tool",
          agentId,
          label: agentDef.name,
          tool: `error_recovery`,
        });
      }

      // Publish error result to bus so orchestrator gets a response (not stuck waiting)
      busPublish(sessionId, agentId, `result:${agentId}`, {
        result: `Error occurred: ${err.message}. Agent is recovering and ready for new tasks.`,
      });

      // Brief backoff before returning to idle
      await new Promise(r => setTimeout(r, 2000));
      console.log(`[Realtime:${agentDef.name}] Recovered from error, returning to idle`);
    }
  }

  handle.status = "completed";
  console.log(`[Realtime:${agentDef.name}] Agent exited`);
}

// --- Human node loop: listens for tasks sent to the human node and forwards to client ---

async function humanNodeLoop(
  agentDef: AgentConfig,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const agentId = agentDef.id;
  console.log(`[Realtime:Human] Human node "${agentId}" listening for agent outputs...`);

  while (!signal.aborted) {
    try {
      // Wait for any agent to send a task/result to the human node
      const msg = await busWaitForMessage(sessionId, `task:${agentId}`, 0, signal);

      const fromAgent = msg.payload?.from || "unknown";
      const content = msg.payload?.task || msg.payload?.result || "(no content)";

      console.log(`[Realtime:Human] Received from ${fromAgent}: ${content.slice(0, 200)}`);

      // Forward to client via status callback
      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "human_node_message",
          agentId: fromAgent,
          label: fromAgent,
          content,
        });
      }
    } catch (err: any) {
      if (err.message === "aborted" || signal.aborted) break;
      console.error(`[Realtime:Human] Error:`, err.message);
    }
  }
  console.log(`[Realtime:Human] Human node "${agentId}" exited`);
}

// --- Human node helpers ---

/** Get agent IDs that the human node is directly connected to */
export function getHumanConnectedAgents(sessionId: string): string[] {
  const session = realtimeSessions.get(sessionId);
  if (!session) return [];

  const humanNode = session.systemConfig.agents?.find((a: AgentConfig) => a.role === "human");
  if (!humanNode) return [];

  const allNonHuman = Array.from(session.agents.entries())
    .filter(([, h]) => h.agentDef.role !== "human")
    .map(([id]) => id);

  // Global mesh/p2p mode OR human node has mesh.enabled: can talk to all agents
  const isGlobalMesh = session.systemConfig.system?.orchestration_mode === "mesh";
  const isP2PMode = session.systemConfig.system?.orchestration_mode === "p2p";
  const humanHasMesh = humanNode.mesh?.enabled === true;
  if (isGlobalMesh || isP2PMode || humanHasMesh) {
    return allNonHuman;
  }

  // Get agents connected FROM the human node
  const connTargets = (session.systemConfig.connections || [])
    .filter((c: any) => c.from === humanNode.id)
    .map((c: any) => c.to);

  // Also include agents connected TO the human node (bidirectional)
  const connSources = (session.systemConfig.connections || [])
    .filter((c: any) => c.to === humanNode.id)
    .map((c: any) => c.from);

  // Also include any agent that has mesh.enabled (they accept tasks from anyone)
  const meshAgents = allNonHuman.filter((id) => {
    const agentDef = session.systemConfig.agents?.find((a: AgentConfig) => a.id === id);
    return agentDef?.mesh?.enabled === true;
  });

  return [...new Set([...connTargets, ...connSources, ...meshAgents])].filter(
    (id) => session.agents.has(id) && session.agents.get(id)!.agentDef.role !== "human"
  );
}

/** Send a task from the human to a specific agent */
export function humanSendToAgent(sessionId: string, targetAgentId: string, task: string, context?: string): { ok: boolean; error?: string } {
  const session = realtimeSessions.get(sessionId);
  if (!session) return { ok: false, error: "No realtime session active." };

  const targetAgent = session.agents.get(targetAgentId);
  if (!targetAgent) {
    const available = Array.from(session.agents.keys()).join(", ");
    return { ok: false, error: `Agent "${targetAgentId}" not found. Available: ${available}` };
  }

  // Verify human is connected to this agent
  // Skip check if: global mesh, p2p, human has mesh.enabled, or target agent has mesh.enabled
  const isGlobalMesh = session.systemConfig.system?.orchestration_mode === "mesh";
  const isP2PMode = session.systemConfig.system?.orchestration_mode === "p2p";
  const humanNode = session.systemConfig.agents?.find((a: AgentConfig) => a.role === "human");
  const humanHasMesh = humanNode?.mesh?.enabled === true;
  const targetHasMesh = targetAgent.agentDef.mesh?.enabled === true;

  if (!isGlobalMesh && !isP2PMode && !humanHasMesh && !targetHasMesh) {
    const humanConnected = getHumanConnectedAgents(sessionId);
    if (humanConnected.length > 0 && !humanConnected.includes(targetAgentId)) {
      return { ok: false, error: `You can only talk to agents connected to the human node: ${humanConnected.join(", ")}` };
    }
  }

  // Publish task to the agent's bus topic
  const humanNodeForPublish = humanNode || session.systemConfig.agents?.find((a: AgentConfig) => a.role === "human");
  busPublish(sessionId, humanNodeForPublish?.id || "human", `task:${targetAgentId}`, {
    task,
    context,
    from: humanNodeForPublish?.id || "human",
  });

  console.log(`[Realtime:Human] Human → ${targetAgentId}: ${task.slice(0, 100)}`);
  return { ok: true };
}

/** Send a task from human to ALL connected agents (broadcast) */
export function humanBroadcastToAgents(sessionId: string, task: string, context?: string): { ok: boolean; sent: string[]; errors: string[] } {
  const connectedAgents = getHumanConnectedAgents(sessionId);
  if (connectedAgents.length === 0) {
    return { ok: false, sent: [], errors: ["No agents connected to the human node"] };
  }

  const sent: string[] = [];
  const errors: string[] = [];

  for (const agentId of connectedAgents) {
    const result = humanSendToAgent(sessionId, agentId, task, context);
    if (result.ok) {
      sent.push(agentId);
    } else {
      errors.push(`${agentId}: ${result.error}`);
    }
  }

  return { ok: sent.length > 0, sent, errors };
}

/** Wait for a result from a specific agent (called by human) */
export async function humanWaitForAgent(sessionId: string, agentId: string, timeoutMs: number = 120000, signal?: AbortSignal): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const resultMsg = await busWaitForMessage(sessionId, `result:${agentId}`, timeoutMs, signal);
    return {
      ok: true,
      result: resultMsg.payload?.result || "(no result)",
    };
  } catch (err: any) {
    return { ok: false, error: `Timeout waiting for ${agentId}: ${err.message}` };
  }
}

// --- Realtime tool implementations ---

async function realtimeSendTask(args: { to: string; task: string; context?: string; wait?: boolean }, signal?: AbortSignal): Promise<any> {
  const sessionId = _currentParentSessionId || "default";
  const session = realtimeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "No realtime session active." };
  }

  const targetAgent = session.agents.get(args.to);
  if (!targetAgent) {
    const available = Array.from(session.agents.keys()).join(", ");
    return { ok: false, error: `Agent "${args.to}" not found. Available: ${available}` };
  }

  // Validate caller is allowed to send to target
  const callerId = _currentAgentId;
  if (callerId === "main") {
    // P2P mode: main can send to any peer agent (no orchestrator hierarchy)
    const isP2PMode = session.systemConfig.system?.orchestration_mode === "p2p";
    const isP2POrchMode = session.systemConfig.system?.orchestration_mode === "p2p_orchestrator";
    if (!isP2PMode && !isP2POrchMode) {
      // Main LLM must respect hierarchy — if there's an orchestrator, only send to it
      const orchestrator = session.systemConfig.agents?.find((a: AgentConfig) => a.role === "orchestrator");
      if (orchestrator && args.to !== orchestrator.id) {
        return { ok: false, error: `You must send tasks to the orchestrator agent "${orchestrator.id}" ("${orchestrator.name}") only. The orchestrator will delegate to other agents.` };
      }
    }
  } else {
    const callerDef = session.systemConfig.agents?.find((a: AgentConfig) => a.id === callerId);
    const callerHasMesh = callerDef?.mesh?.enabled === true;
    const globalMesh = session.systemConfig.system?.orchestration_mode === "mesh";
    const globalP2P = session.systemConfig.system?.orchestration_mode === "p2p";
    const isHybridOrch = session.systemConfig.system?.orchestration_mode === "hybrid" && callerDef?.role === "orchestrator";
    const isP2POrchMode = session.systemConfig.system?.orchestration_mode === "p2p_orchestrator";
    const isP2POrch = isP2POrchMode && callerDef?.role === "orchestrator";
    const callerIsBidder = callerDef?.p2p?.bidder === true && isP2POrchMode;

    // Guard: block non-orchestrator agents from sending tasks to the orchestrator (circular delegation)
    if (!isP2POrch && (isP2POrchMode || isHybridOrch || session.systemConfig.system?.orchestration_mode === "hierarchical")) {
      const targetDef = session.systemConfig.agents?.find((a: AgentConfig) => a.id === args.to);
      if (targetDef?.role === "orchestrator") {
        console.log(`[send_task] BLOCKED: "${callerId}" (${callerDef?.role}) tried to send task to orchestrator "${args.to}" — circular delegation prevented`);
        return { ok: false, error: `Agent "${callerId}" cannot send tasks to orchestrator "${args.to}". Only the orchestrator delegates work downward. If you need to report results, use bb_complete or proto_bus_publish instead.` };
      }
    }

    if (isP2POrch) {
      // P2P Orchestrator: can send_task to connected agents freely,
      // but bidder-only agents (not in connections) must go through blackboard first
      const callerStep = session.systemConfig.workflow?.sequence?.find((s: any) => s.agent === callerId);
      const allowedTargets: string[] = callerStep?.outputs_to || [];
      const connTargets = (session.systemConfig.connections || [])
        .filter((c: any) => c.from === callerId)
        .map((c: any) => c.to);
      const directTargets = [...new Set([...allowedTargets, ...connTargets])];

      const targetDef = session.systemConfig.agents?.find((a: AgentConfig) => a.id === args.to);
      const targetIsBidderOnly = targetDef?.p2p?.bidder === true && !directTargets.includes(args.to);

      if (targetIsBidderOnly) {
        // Check if this bidder was awarded a task on the blackboard
        const bb = blackboardGet(sessionId);
        const allTasks = bb.getTasks();
        const wasAwarded = allTasks.some((t: any) => t.awardedTo === args.to && (t.status === "awarded" || t.status === "in_progress"));
        if (!wasAwarded) {
          return { ok: false, error: `Agent "${args.to}" is a P2P bidder with no direct connection. You must use blackboard bidding first: bb_propose → wait for bids → bb_award → then send_task to the winner. Direct targets: ${directTargets.join(", ") || "(none)"}` };
        }
      }
    } else if (!callerHasMesh && !globalMesh && !globalP2P && !isHybridOrch && !callerIsBidder) {
      // Strict access control via connections
      const callerStep = session.systemConfig.workflow?.sequence?.find((s: any) => s.agent === callerId);
      const allowedTargets: string[] = callerStep?.outputs_to || [];
      const connTargets = (session.systemConfig.connections || [])
        .filter((c: any) => c.from === callerId)
        .map((c: any) => c.to);
      const allAllowed = [...new Set([...allowedTargets, ...connTargets])];

      if (allAllowed.length > 0 && !allAllowed.includes(args.to)) {
        return { ok: false, error: `Agent "${callerId}" is not connected to "${args.to}". Allowed targets: ${allAllowed.join(", ")}` };
      }
    }
  }

  // If target is a human node, route output to client via callback (not LLM loop)
  if (targetAgent.agentDef.role === "human") {
    console.log(`[Realtime] ${_currentAgentId} → send_task → HUMAN (${args.to}): ${args.task.slice(0, 100)}`);
    // Collect any output files from this agent's last run
    const callerHandle = session.agents.get(_currentAgentId);
    const callerFiles: string[] = [];
    // Check bus history for this agent's most recent result which may contain outputFiles
    const recentResults = busHistory(sessionId, `result:${_currentAgentId}`);
    if (recentResults.length > 0) {
      const lastResult = recentResults[recentResults.length - 1];
      if (lastResult.payload?.outputFiles) {
        callerFiles.push(...lastResult.payload.outputFiles);
      }
    }
    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId,
        status: "human_node_message",
        agentId: _currentAgentId,
        label: session.agents.get(_currentAgentId)?.agentDef.name || _currentAgentId,
        content: args.task,
        outputFiles: callerFiles.length > 0 ? callerFiles : undefined,
      });
    }
    return {
      ok: true,
      agentId: args.to,
      agentName: targetAgent.agentDef.name,
      sent: true,
      note: `Output sent to human user.`,
    };
  }

  // Publish task to the agent's bus topic
  busPublish(sessionId, _currentAgentId, `task:${args.to}`, {
    task: args.task,
    context: args.context,
    from: _currentAgentId,
  });

  console.log(`[Realtime] ${_currentAgentId} → send_task → ${args.to}: ${args.task.slice(0, 100)}`);

  // If wait=true, block until the agent publishes its result
  if (args.wait) {
    try {
      const settings = await getSettings();
      const timeout = (args as any).timeout || (settings.subAgentTimeout || 120);
      const resultMsg = await busWaitForMessage(sessionId, `result:${args.to}`, timeout * 1000, signal);
      return {
        ok: true,
        agentId: args.to,
        agentName: targetAgent.agentDef.name,
        result: resultMsg.payload?.result || "(no result)",
        outputFiles: resultMsg.payload?.outputFiles || [],
      };
    } catch (err: any) {
      const agentStatus = targetAgent.status;
      const stillWorking = agentStatus === "working";
      return {
        ok: false,
        error: `Timeout waiting for ${args.to}: ${err.message}`,
        agentStatus,
        stillWorking,
        hint: stillWorking
          ? `Agent "${targetAgent.agentDef.name}" is still working. The result will be automatically forwarded to the user when it arrives.`
          : `Agent "${targetAgent.agentDef.name}" status: "${agentStatus}".`,
      };
    }
  }

  return {
    ok: true,
    agentId: args.to,
    agentName: targetAgent.agentDef.name,
    sent: true,
    note: `Task sent to ${targetAgent.agentDef.name}. Use wait_result({from: "${args.to}"}) to collect the result.`,
  };
}

async function realtimeWaitResult(args: { from: string; timeout?: number }, signal?: AbortSignal): Promise<any> {
  const sessionId = _currentParentSessionId || "default";
  const session = realtimeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "No realtime session active." };
  }

  const targetAgent = session.agents.get(args.from);
  if (!targetAgent) {
    return { ok: false, error: `Agent "${args.from}" not found in session.` };
  }

  // If agent already has a result cached and is idle, return it immediately
  if (targetAgent.status === "idle" && targetAgent.lastResult) {
    const result = targetAgent.lastResult;
    targetAgent.lastResult = undefined; // consume it
    return {
      ok: true,
      agentId: args.from,
      agentName: targetAgent.agentDef.name,
      result,
    };
  }

  // Otherwise wait for the bus message
  try {
    const settings = await getSettings();
    const timeout = (args.timeout || settings.subAgentTimeout || 120) * 1000;
    const resultMsg = await busWaitForMessage(sessionId, `result:${args.from}`, timeout, signal);
    return {
      ok: true,
      agentId: args.from,
      agentName: targetAgent.agentDef.name,
      result: resultMsg.payload?.result || "(no result)",
      outputFiles: resultMsg.payload?.outputFiles || [],
    };
  } catch (err: any) {
    const agentStatus = targetAgent.status;
    const stillWorking = agentStatus === "working";
    return {
      ok: false,
      error: `Timeout waiting for result from ${args.from}: ${err.message}`,
      agentStatus,
      stillWorking,
      hint: stillWorking
        ? `Agent "${targetAgent.agentDef.name}" is still working. The result will be automatically forwarded to the user when it arrives.`
        : `Agent "${targetAgent.agentDef.name}" status: "${agentStatus}".`,
    };
  }
}

function realtimeCheckAgents(): any {
  const sessionId = _currentParentSessionId || "default";
  const session = realtimeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "No realtime session active." };
  }

  const agents = Array.from(session.agents.entries()).map(([id, handle]) => ({
    id,
    name: handle.agentDef.name,
    role: handle.agentDef.role,
    status: handle.status,
    lastTask: handle.lastTask?.slice(0, 100),
  }));

  return { ok: true, agents, total: agents.length };
}

// --- Collect pending results from agents that finished ---

export function collectPendingResults(sessionId: string): Array<{ agentId: string; agentName: string; result: string; outputFiles?: string[] }> {
  const session = realtimeSessions.get(sessionId);
  if (!session) return [];

  const results: Array<{ agentId: string; agentName: string; result: string; outputFiles?: string[] }> = [];

  // First check handle.lastResult (set when agent finishes)
  for (const [id, handle] of session.agents.entries()) {
    if (handle.agentDef.role === "human") continue;
    if (handle.lastResult) {
      results.push({
        agentId: id,
        agentName: handle.agentDef.name,
        result: handle.lastResult,
      });
      handle.lastResult = undefined; // consume it
    }
  }

  // Fallback: scan bus history for result messages if handle had no cached result
  if (results.length === 0) {
    for (const [agentId, handle] of session.agents.entries()) {
      if (handle.agentDef.role === "human") continue;
      const history = busHistory(sessionId, `result:${agentId}`);
      if (history.length > 0) {
        const last = history[history.length - 1];
        results.push({
          agentId,
          agentName: handle.agentDef.name,
          result: last.payload?.result || "(no result)",
          outputFiles: last.payload?.outputFiles,
        });
      }
    }
  }

  return results;
}

// --- Get working agents ---

export function getWorkingAgents(sessionId: string): Array<{ agentId: string; agentName: string }> {
  const session = realtimeSessions.get(sessionId);
  if (!session) return [];
  const working: Array<{ agentId: string; agentName: string }> = [];
  for (const [id, handle] of session.agents.entries()) {
    if (handle.agentDef.role === "human") continue;
    if (handle.status === "working") {
      working.push({ agentId: id, agentName: handle.agentDef.name });
    }
  }
  return working;
}

/** Check if there are unfinished blackboard tasks (open, bidding, awarded, or in_progress) */
export function getPendingBlackboardTasks(sessionId: string): Array<{ taskId: string; status: string; description: string }> {
  const allTasks = blackboardGetTasks(sessionId);
  return allTasks
    .filter((t: any) => ["open", "bidding", "awarded", "in_progress"].includes(t.status))
    .map((t: any) => ({ taskId: t.taskId, status: t.status, description: t.description?.slice(0, 100) || "" }));
}

// --- Get tools for realtime orchestrator ---

export async function getToolsForRealtimeOrchestrator(): Promise<any[]> {
  const settings = await getSettings();

  // In realtime mode, the main LLM should DELEGATE work, not do it itself.
  // Only give it coordination tools + minimal output tools.
  // Giving it web_search, run_python, fetch_url etc. causes it to bypass the agent team.
  const essentialTools = builtinTools.filter((t: any) => {
    const name = t.function?.name || "";
    // Keep only: file I/O (for saving final results), skill listing, and code execution
    // for synthesizing outputs. Remove research tools that agents should handle.
    return ["write_file", "read_file", "list_files", "run_python", "run_react", "list_skills", "load_skill"].includes(name);
  });

  const tools: any[] = [...essentialTools];

  // Core: realtime coordination tools (these are the PRIMARY tools)
  tools.push(sendTaskTool, waitResultTool, checkAgentsTool);
  // Protocol tools for direct orchestrator communication
  tools.push(...protocolTools);
  return [...tools, ...getMcpTools()];
}

// --- Config summary for realtime mode ---

export async function getRealtimeAgentConfigSummary(): Promise<string | null> {
  const settings = await getSettings();
  if (settings.subAgentMode !== "realtime" || !settings.subAgentConfigFile) return null;
  const config = loadAgentConfig(settings.subAgentConfigFile);
  if (!config) return null;

  // Find the orchestrator agent (role === "orchestrator")
  const orchestrator = config.agents?.find((a: AgentConfig) => a.role === "orchestrator");

  const mode = config.system?.orchestration_mode || "hierarchical";
  let summary = `\n\nREALTIME AGENT SESSION (${config.system?.name || "Unnamed"}, mode: ${mode}):\n`;

  const isP2P = mode === "p2p";
  const isP2POrch = mode === "p2p_orchestrator";

  // Mode description
  if (isP2P) {
    const mechanism = config.system?.p2p_governance?.consensus_mechanism || "contract_net";
    summary += `P2P swarm — autonomous peers self-organize via blackboard (${mechanism}).\n`;
  } else if (isP2POrch && orchestrator) {
    const bidders = (config.agents || []).filter((a: AgentConfig) => a.p2p?.bidder === true);
    summary += `P2P orchestrator — "${orchestrator.id}" delegates directly or via blackboard bidding.\n`;
    if (bidders.length > 0) summary += `Bidders: ${bidders.map(a => a.id).join(", ")}\n`;
  } else if (orchestrator) {
    summary += `Orchestrator: ${orchestrator.id} ("${orchestrator.name}")`;
    if (mode === "hybrid") {
      const meshIds = (config.agents || []).filter((a: AgentConfig) => a.mesh?.enabled && a.role !== "human").map(a => a.id);
      summary += ` | Hybrid: mesh agents (${meshIds.join(", ")}) collaborate freely`;
    }
    summary += `\n`;
  }

  // Agent list (compact)
  summary += `\nAgents:\n`;
  for (const a of config.agents || []) {
    const flags = [a.bus?.enabled && "bus", a.mesh?.enabled && "mesh"].filter(Boolean).join(",");
    summary += `- ${a.id} ("${a.name}"): ${a.role}${flags ? ` [${flags}]` : ""}${a.persona ? ` — ${a.persona}` : ""}\n`;
  }

  // Connections
  if (config.connections && config.connections.length > 0) {
    summary += `\nConnections: ${config.connections.map(c => `${c.from}→${c.to}(${c.protocol})`).join(", ")}\n`;
  }

  // Workflow
  if (config.workflow?.sequence && config.workflow.sequence.length > 0) {
    summary += `\nWorkflow: ${config.workflow.sequence.map((s: any) => {
      const out = s.outputs_to ? `→${s.outputs_to.join(",")}` : "";
      return `${s.step}.${s.agent}: ${s.action}${out}`;
    }).join(" | ")}\n`;
  }

  // Delegation instructions (compact)
  summary += `\nDelegation: `;
  if (isP2P) {
    const peerIds = (config.agents || []).filter((a: AgentConfig) => a.role !== "human").map(a => a.id);
    summary += `Send tasks to peers (${peerIds.join(", ")}) via send_task/wait_result. Agents self-organize via blackboard.\n`;
  } else if (orchestrator) {
    summary += `Send ALL tasks to "${orchestrator.id}" only via send_task → wait_result. Do not bypass the orchestrator.\n`;
  } else {
    summary += `Use send_task/wait_result to assign work. Send to multiple agents for parallel execution.\n`;
  }
  summary += `Synthesize agent results into a clear response with headings. Mention any generated files. Use run_python for charts/reports when appropriate.\n`;
  return summary;
}

// --- Dispatcher ---

// Per-task call context (supports parallel tasks without global state corruption)
interface CallContext {
  parentSessionId?: string;
  subagentDepth: number;
  agentId: string;
  projectWorkingFolder?: string;
}

const callContexts = new Map<string, CallContext>();

// Global fallback context — used by helper functions (runPython, spawnSubagent, etc.)
// that don't yet receive a taskId. Updated on every setCallContext call.
let _currentParentSessionId: string | undefined;
let _currentSubagentDepth: number = 0;
let _currentAgentId: string = "main";
let _currentProjectWorkingFolder: string | undefined;

export function setCallContext(taskId: string, sessionId?: string, depth?: number, agentId?: string, projectWorkingFolder?: string) {
  const ctx: CallContext = {
    parentSessionId: sessionId,
    subagentDepth: depth || 0,
    agentId: agentId || "main",
    projectWorkingFolder,
  };
  callContexts.set(taskId, ctx);
  // Update globals as fallback for functions that don't have taskId
  _currentParentSessionId = sessionId;
  _currentSubagentDepth = depth || 0;
  _currentAgentId = agentId || "main";
  _currentProjectWorkingFolder = projectWorkingFolder;
}

export function clearCallContext(taskId: string) {
  callContexts.delete(taskId);
}

export async function callTool(name: string, args: any, signal?: AbortSignal, taskId?: string): Promise<any> {
  const ctx = taskId ? callContexts.get(taskId) : undefined;
  const _currentParentSessionId = ctx?.parentSessionId;
  const _currentSubagentDepth = ctx?.subagentDepth || 0;
  const _currentAgentId = ctx?.agentId || "main";
  const _currentProjectWorkingFolder = ctx?.projectWorkingFolder;

  switch (name) {
    case "web_search": return webSearch(args);
    case "openrouter_web_search": return openRouterWebSearch(args);
    case "fetch_url": return fetchUrl(args);
    case "run_python": return runPythonTool(args);
    case "run_react": return runReactTool(args);
    case "run_shell": return runShell(args);
    case "read_file": return readFileTool(args);
    case "write_file": return writeFileTool(args);
    case "list_files": return listFilesTool(args);
    case "list_skills": return listSkillsTool();
    case "load_skill": return loadSkillTool(args);
    case "clawhub_search": return clawhubSearchTool(args);
    case "clawhub_install": return clawhubInstallTool(args);
    case "spawn_subagent": return spawnSubagent(args, _currentParentSessionId, _currentSubagentDepth);

    // ─── Realtime Agent Tools ───
    case "send_task": return realtimeSendTask(args, signal);
    case "wait_result": return realtimeWaitResult(args, signal);
    case "check_agents": return realtimeCheckAgents();

    // ─── Protocol Tools ───
    case "proto_tcp_send": {
      const sessionId = _currentParentSessionId || "default";
      const from = _currentAgentId;
      await tcpOpen(from, args.to, sessionId);
      const sent = await tcpSend(from, args.to, args.topic, args.payload);
      return { ok: sent, protocol: "tcp", from, to: args.to, topic: args.topic };
    }
    case "proto_tcp_read": {
      const from = _currentAgentId;
      const messages = tcpRead(from, args.peer);
      return { ok: true, protocol: "tcp", peer: args.peer, messages, count: messages.length };
    }
    case "proto_bus_publish": {
      const sessionId = _currentParentSessionId || "default";
      busPublish(sessionId, _currentAgentId, args.topic, args.payload);
      return { ok: true, protocol: "bus", from: _currentAgentId, topic: args.topic };
    }
    case "proto_bus_history": {
      const sessionId = _currentParentSessionId || "default";
      const messages = busHistory(sessionId, args.topic);
      return { ok: true, protocol: "bus", topic: args.topic || "all", messages, count: messages.length };
    }
    case "proto_queue_send": {
      const sessionId = _currentParentSessionId || "default";
      const depth = queueEnqueue(_currentAgentId, args.to, args.topic, args.payload, sessionId);
      return { ok: true, protocol: "queue", from: _currentAgentId, to: args.to, topic: args.topic, queueDepth: depth };
    }
    case "proto_queue_receive": {
      const msg = queueDequeue(args.from, _currentAgentId, args.topic);
      return msg
        ? { ok: true, protocol: "queue", message: msg }
        : { ok: true, protocol: "queue", message: null, note: "Queue empty" };
    }
    case "proto_queue_peek": {
      const messages = queuePeek(args.from, _currentAgentId, args.topic, args.count || 5);
      return { ok: true, protocol: "queue", messages, count: messages.length };
    }

    // ─── Blackboard / P2P Governance Tools ───
    case "bb_propose": {
      const sessionId = _currentParentSessionId || "default";

      // Guard: only orchestrator-role agents can propose tasks (prevents scope creep from worker agents)
      const rtSessionForPropose = realtimeSessions.get(sessionId);
      if (rtSessionForPropose) {
        const callerDefForPropose = rtSessionForPropose.systemConfig.agents?.find((a: AgentConfig) => a.id === _currentAgentId);
        if (callerDefForPropose && callerDefForPropose.role !== "orchestrator" && callerDefForPropose.role !== "human") {
          console.log(`[bb_propose] BLOCKED: "${_currentAgentId}" (role: ${callerDefForPropose.role}) is not an orchestrator — only orchestrators can propose tasks`);
          return { ok: false, error: `Only orchestrator agents can propose tasks via bb_propose. Agent "${_currentAgentId}" (role: ${callerDefForPropose.role}) should complete assigned work, not create new tasks. Use bb_complete to report results instead.` };
        }
      }

      const task = blackboardPropose(sessionId, _currentAgentId, args.description, args.task_id);

      // If task was already completed or in progress, don't re-broadcast to bidders
      if ((task as any).skipped) {
        console.log(`[bb_propose] Task "${task.taskId}" skipped (status: ${task.status}) — not waking bidders`);
        return { ok: true, protocol: "blackboard", action: "propose", task,
          skipped: true,
          bidders_notified: [],
          hint: `Task "${task.taskId}" is already ${task.status}. No need to re-dispatch — ${task.status === "completed" ? "results are available via bb_read" : "work is in progress"}.` };
      }

      // Notify all agents via bus so bidders can discover the new task
      const proposedTaskId = task.taskId;
      busPublish(sessionId, _currentAgentId, "bb:new_task", {
        task_id: proposedTaskId,
        description: args.description,
        proposed_by: _currentAgentId,
      });
      // Wake up bidder agents in realtime mode by sending them a task on their task: topic
      const rtSession = realtimeSessions.get(sessionId);
      const wokenBidders: string[] = [];
      console.log(`[bb_propose] sessionId=${sessionId}, rtSession=${!!rtSession}, caller=${_currentAgentId}, taskId=${proposedTaskId}`);
      if (rtSession) {
        const allAgents = rtSession.systemConfig.agents || [];
        const bidderAgents = allAgents
          .filter((a: AgentConfig) => a.id !== _currentAgentId && a.role !== "human" && a.p2p?.bidder === true);
        console.log(`[bb_propose] Total agents: ${allAgents.length}, bidders found: ${bidderAgents.length}, ids: ${bidderAgents.map((a: AgentConfig) => a.id).join(", ")}`);

        // Fast-path: if ≤2 bidders, auto-assign to the first one (skip full bidding cycle)
        const p2pGov = rtSession.systemConfig.system?.p2p_governance;
        const autoAssignThreshold = p2pGov?.auto_assign_threshold ?? 2;
        if (bidderAgents.length > 0 && bidderAgents.length <= autoAssignThreshold) {
          // Round-robin among available bidders for fair distribution
          const assignee = bidderAgents[Math.floor(Math.random() * bidderAgents.length)];
          console.log(`[bb_propose] Auto-assigning task "${proposedTaskId}" to "${assignee.id}" (only ${bidderAgents.length} bidder(s), threshold=${autoAssignThreshold})`);
          // Auto-bid, award, and start
          blackboardBid(sessionId, assignee.id, proposedTaskId, 1.0);
          blackboardAward(sessionId, proposedTaskId, assignee.id);
          blackboardStartTask(sessionId, assignee.id, proposedTaskId);
          busPublish(sessionId, _currentAgentId, "bb:task_awarded", {
            task_id: proposedTaskId,
            awarded_to: assignee.id,
            description: args.description,
            auto_assigned: true,
          });
          return { ok: true, protocol: "blackboard", action: "propose", task,
            auto_assigned: true,
            assigned_to: assignee.id,
            bidders_notified: [],
            hint: `Task auto-assigned to "${assignee.id}" (${bidderAgents.length} bidder(s) — below threshold ${autoAssignThreshold}, bidding skipped). Use send_task({to: "${assignee.id}", task: "..."}) to deliver the work NOW.` };
        }

        for (const bidder of bidderAgents) {
          console.log(`[bb_propose] Waking bidder ${bidder.id} via task:${bidder.id}`);
          busPublish(sessionId, _currentAgentId, `task:${bidder.id}`, {
            task: `A new task has been posted on the blackboard (task_id: "${proposedTaskId}"): "${args.description}". Use bb_read to review it, then use bb_bid(task_id="${proposedTaskId}", confidence=<your_confidence_score>) to bid if it matches your expertise. Do NOT execute the task yet — only bid.`,
            context: `Blackboard bidding request from ${_currentAgentId}. This is a bid request, not a direct task assignment.`,
            from: _currentAgentId,
          });
          wokenBidders.push(bidder.id);
        }
      }
      return { ok: true, protocol: "blackboard", action: "propose", task,
        bidders_notified: wokenBidders,
        hint: `Task posted to blackboard. ${wokenBidders.length} bidder agent(s) notified: ${wokenBidders.join(", ") || "none"}. Wait briefly, then use bb_read to check for bids before calling bb_award.` };
    }
    case "bb_bid": {
      const sessionId = _currentParentSessionId || "default";
      const result = blackboardBid(sessionId, _currentAgentId, args.task_id, args.confidence, args.cost, args.reasoning);
      // Notify proposer that a bid arrived
      if (result.ok) {
        busPublish(sessionId, _currentAgentId, "bb:bid_received", {
          task_id: args.task_id,
          bidder: _currentAgentId,
          confidence: args.confidence,
        });
      }
      return { ...result, protocol: "blackboard", action: "bid" };
    }
    case "bb_award": {
      const sessionId = _currentParentSessionId || "default";
      // If orchestrator_scores provided, compute combined scores and determine winner
      let awardTo = args.award_to;
      let scoringDetails: any[] | undefined;
      if (!awardTo && args.orchestrator_scores?.length > 0) {
        const task = blackboardGetTask(sessionId, args.task_id);
        if (task && task.bids?.length > 0) {
          const orchScoreMap = new Map<string, { score: number; reason?: string }>();
          for (const s of args.orchestrator_scores) {
            orchScoreMap.set(s.agent_id, { score: s.score, reason: s.reason });
          }
          scoringDetails = task.bids.map((bid: any) => {
            const orchEntry = orchScoreMap.get(bid.agentId);
            const orchScore = orchEntry?.score ?? 0.5;
            const combined = (bid.confidence * 0.5) + (orchScore * 0.5);
            return {
              agent_id: bid.agentId,
              bidder_confidence: bid.confidence,
              orchestrator_score: orchScore,
              orchestrator_reason: orchEntry?.reason || "",
              combined_score: Math.round(combined * 1000) / 1000,
            };
          });
          // Pick the highest combined score
          scoringDetails.sort((a: any, b: any) => b.combined_score - a.combined_score);
          awardTo = scoringDetails[0].agent_id;
        }
      }
      const result = blackboardAward(sessionId, args.task_id, awardTo);
      if (result.ok && result.awardedTo) {
        blackboardStartTask(sessionId, result.awardedTo, args.task_id);
        // Notify the winner via bus with the task details
        const awardedTask = blackboardGetTask(sessionId, args.task_id);
        busPublish(sessionId, _currentAgentId, "bb:task_awarded", {
          task_id: args.task_id,
          awarded_to: result.awardedTo,
          description: awardedTask?.description || "",
          scoring: scoringDetails || undefined,
        });
      }
      return { ...result, protocol: "blackboard", action: "award",
        scoring: scoringDetails || undefined,
        next_step: result.ok && result.awardedTo
          ? `Task awarded to "${result.awardedTo}". NOW send the task to the winner: use send_task({to: "${result.awardedTo}", task: "..."}) in realtime mode, or spawn_subagent({agentId: "${result.awardedTo}", task: "..."}) in manual mode. Then collect results.`
          : undefined };
    }
    case "bb_complete": {
      const sessionId = _currentParentSessionId || "default";
      const result = blackboardCompleteTask(sessionId, _currentAgentId, args.task_id, args.result);
      return { ...result, protocol: "blackboard", action: "complete" };
    }
    case "bb_read": {
      const sessionId = _currentParentSessionId || "default";
      // Helper: enrich bids with bidder profile info from agent config
      const enrichTask = (task: any) => {
        if (!task || !task.bids || task.bids.length === 0) return task;
        const rtSession = realtimeSessions.get(sessionId);
        const agents = rtSession?.systemConfig?.agents || [];
        const enrichedBids = task.bids.map((bid: any) => {
          const agentDef = agents.find((a: AgentConfig) => a.id === bid.agentId);
          return {
            ...bid,
            bidder_profile: agentDef ? {
              name: agentDef.name,
              role: agentDef.role,
              persona: agentDef.persona,
              confidence_domains: agentDef.p2p?.confidence_domains || [],
              reputation_score: agentDef.p2p?.reputation_score ?? null,
              responsibilities: agentDef.responsibilities || [],
            } : undefined,
          };
        });
        return { ...task, bids: enrichedBids };
      };
      if (args.task_id) {
        const task = blackboardGetTask(sessionId, args.task_id);
        return { ok: true, protocol: "blackboard", action: "read", task: task ? enrichTask(task) : null };
      }
      const tasks = blackboardGetTasks(sessionId, args.status);
      return { ok: true, protocol: "blackboard", action: "read", tasks: tasks.map(enrichTask), count: tasks.length };
    }
    case "bb_log": {
      const sessionId = _currentParentSessionId || "default";
      const log = blackboardGetLog(sessionId, args.limit || 50);
      return { ok: true, protocol: "blackboard", action: "log", entries: log, count: log.length };
    }

    default:
      // Route MCP tools to MCP client
      if (isMcpTool(name)) return callMcpTool(name, args);
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
