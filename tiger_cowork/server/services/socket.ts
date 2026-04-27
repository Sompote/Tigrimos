import { Server, Socket } from "socket.io";
import { v4 as uuid } from "uuid";
import { callTigerBotWithTools, callTigerBot, trimConversationContext, compressOlderMessages, estimateMessagesChars } from "./tigerbot";
import { getChatHistory, saveChatHistory, ChatSession, getSettings, getProjects, getSkills, runWithSettingsOverride } from "./data";
import { runPython } from "./python";
import { setSubagentStatusCallback, setCallContext, clearCallContext, loadAgentConfig, getManualAgentConfigSummary, startRealtimeSession, shutdownRealtimeSession, getRealtimeSession, getToolsForRealtimeOrchestrator, getHumanConnectedAgents, humanSendToAgent, humanBroadcastToAgents, humanWaitForAgent, collectPendingResults, getWorkingAgents, getAutoCreatedArchitecture, getAutoSwarmSelection, callTool } from "./toolbox";
import { busSubscribe, busPublish, busWaitForMessage } from "./protocols";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import yaml from "js-yaml";

// Resolve sandboxDir with fallback — must stay in sync with SANDBOX_DIR in index.ts
function resolveSandboxDir(configured?: string): string {
  if (configured && fs.existsSync(configured)) return configured;
  const envDir = process.env.SANDBOX_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  const cwd = process.cwd();
  if (fs.existsSync(cwd)) return cwd;
  const tmp = path.join(process.env.TMPDIR || "/tmp", "tigrimos_sandbox");
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

// ─── Scan output_file/ for newly created files ───
const OUTPUT_EXTS = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp", ".txt", ".md"];
const COMPRESS_MSG_THRESHOLD = 20;      // compress when more than 20 messages
const COMPRESS_CHAR_THRESHOLD = 200_000; // or when total content exceeds 200K chars (~50K tokens)

function scanOutputFiles(sandboxDir: string, sinceMs: number): string[] {
  const outputDir = path.join(sandboxDir, "output_file");
  const found: string[] = [];
  try {
    if (!fs.existsSync(outputDir)) return found;
    for (const f of fs.readdirSync(outputDir)) {
      const ext = path.extname(f).toLowerCase();
      const isJsxJs = f.endsWith(".jsx.js");
      if (!OUTPUT_EXTS.includes(ext) && !isJsxJs) continue;
      const fullPath = path.join(outputDir, f);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs >= sinceMs - 1000) {
        found.push(path.relative(sandboxDir, fullPath));
      }
    }
  } catch {}
  return found;
}

// ─── Active Agent Task Tracking ───
export interface ActiveTask {
  id: string;
  sessionId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  status: string;
  toolCalls: string[];
  activeAgent?: string;          // last active agent (for backward compat)
  activeAgents: Set<string>;     // all currently working agents
  doneAgents: Set<string>;       // agents that have finished
  agentTools: Record<string, string[]>; // agent name → tools used (capped)
  startedAt: string;
  lastUpdate: string;
}

const MAX_TOOL_HISTORY = 100; // cap per-agent tool list to prevent memory growth

function pushToolCapped(arr: string[], tool: string) {
  arr.push(tool);
  if (arr.length > MAX_TOOL_HISTORY) arr.splice(0, arr.length - MAX_TOOL_HISTORY);
}

const activeTasks = new Map<string, ActiveTask>();
const taskAbortControllers = new Map<string, AbortController>();

// Finished tasks history (in-memory ring buffer, last 100)
export interface FinishedTask {
  id: string;
  sessionId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  status: "completed" | "cancelled" | "error";
  toolCalls: string[];
  agents: string[];
  agentTools: Record<string, string[]>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
const finishedTasks: FinishedTask[] = [];
const MAX_FINISHED = 100;

function recordFinishedTask(task: ActiveTask, status: "completed" | "cancelled" | "error" = "completed") {
  const finishedAt = new Date().toISOString();
  const startedMs = new Date(task.startedAt).getTime();
  const durationMs = Date.now() - startedMs;
  const allAgents = new Set<string>([...task.activeAgents, ...task.doneAgents, ...Object.keys(task.agentTools || {})]);
  finishedTasks.unshift({
    id: task.id,
    sessionId: task.sessionId,
    projectId: task.projectId,
    projectName: task.projectName,
    title: task.title,
    status,
    toolCalls: [...task.toolCalls],
    agents: Array.from(allAgents),
    agentTools: { ...task.agentTools },
    startedAt: task.startedAt,
    finishedAt,
    durationMs,
  });
  if (finishedTasks.length > MAX_FINISHED) finishedTasks.length = MAX_FINISHED;
}

export function getFinishedTasks(): FinishedTask[] {
  return [...finishedTasks];
}

export function getActiveTasks(): (Omit<ActiveTask, 'activeAgents' | 'doneAgents'> & { activeAgents: string[]; doneAgents: string[] })[] {
  return Array.from(activeTasks.values()).map(t => ({
    ...t,
    activeAgents: Array.from(t.activeAgents),
    doneAgents: Array.from(t.doneAgents),
    activeAgent: t.activeAgents.size > 0 ? Array.from(t.activeAgents).join(", ") : t.activeAgent,
  }));
}

export function killActiveTask(taskId: string): boolean {
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    controller.abort();
    // Record as cancelled before deletion
    const task = activeTasks.get(taskId);
    if (task) recordFinishedTask(task, "cancelled");
    activeTasks.delete(taskId);
    taskAbortControllers.delete(taskId);
    return true;
  }
  return false;
}

async function getLocalMountsPrompt(): Promise<string> {
  try {
    const settings = await getSettings();
    const mounts = (settings.localFileMounts || []).filter((m: any) => m.enabled);
    if (mounts.length === 0) return "";
    let block = "\n\n=== HOST FOLDERS (mounted from outside sandbox) ===";
    block += "\nThese folders are shared from the host machine. Use ABSOLUTE paths with read_file, write_file, list_files, delete_file, run_python, and run_shell.";
    for (const m of mounts) {
      block += `\n- "${m.label}" → ${m.path} [${m.permissions === "readwrite" ? "read & write" : "read only"}]`;
    }
    block += "\nTo work in a host folder with run_python, use absolute paths (e.g. open('" + mounts[0].path + "/file.txt')). For run_shell, pass the mount path as cwd.";
    return block;
  } catch {
    return "";
  }
}

export async function buildSystemPrompt(filterSkillIds?: string[], options?: { includeAgentConfig?: boolean }): Promise<string> {
  // Gather installed clawhub skills
  const clawhubDir = path.resolve("Tiger_bot/skills");
  let clawhubSkills: string[] = [];
  try {
    if (fs.existsSync(clawhubDir)) {
      clawhubSkills = fs.readdirSync(clawhubDir, { withFileTypes: true })
        .filter((d: any) => d.isDirectory() && fs.existsSync(path.join(clawhubDir, d.name, "SKILL.md")))
        .map((d: any) => d.name);
    }
  } catch {}

  // Gather custom uploaded skills from /skills/
  const customDir = path.resolve("skills");
  let customSkills: { name: string; description: string; files: string[] }[] = [];
  try {
    if (fs.existsSync(customDir)) {
      const dirs = fs.readdirSync(customDir, { withFileTypes: true }).filter((d: any) => d.isDirectory());
      for (const d of dirs) {
        const skillMdPath = path.join(customDir, d.name, "SKILL.md");
        let desc = "";
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, "utf8");
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            try {
              const parsed = yaml.load(fmMatch[1]) as any;
              if (parsed && typeof parsed === "object" && typeof parsed.description === "string") {
                desc = parsed.description.replace(/\s+/g, " ").trim();
              }
            } catch {}
          }
        }
        // List supporting files in the skill folder
        const files = fs.readdirSync(path.join(customDir, d.name), { withFileTypes: true })
          .filter((f: any) => !f.isDirectory())
          .map((f: any) => f.name);
        customSkills.push({ name: d.name, description: desc, files });
      }
    }
  } catch {}

  // Filter clawhub and custom skills by enabled status in skills.json
  let allSkillRecords: { id: string; name: string; enabled: boolean; source: string }[] = [];
  try {
    allSkillRecords = await getSkills();
  } catch {}
  const disabledSkillNames = new Set(allSkillRecords.filter((s) => !s.enabled).map((s) => s.name));
  clawhubSkills = clawhubSkills.filter((name) => !disabledSkillNames.has(name));
  customSkills = customSkills.filter((cs) => !disabledSkillNames.has(cs.name));

  // Also include enabled skills from skills.json that aren't already listed
  let registeredSkills: string[] = [];
  registeredSkills = allSkillRecords
    .filter((s) => s.enabled && !clawhubSkills.includes(s.name) && !customSkills.some((cs) => cs.name === s.name))
    .map((s) => `${s.name} (${s.source})`);

  // If project has specific skill selections, filter to only those
  if (filterSkillIds && filterSkillIds.length > 0) {
    // Resolve skill IDs (UUIDs) to skill names for matching against filesystem-discovered skills
    const allSkills = await getSkills();
    const selectedSkillNames = new Set(
      allSkills.filter((s) => filterSkillIds.includes(s.id)).map((s) => s.name)
    );
    clawhubSkills = clawhubSkills.filter((name) => selectedSkillNames.has(name) || filterSkillIds.includes(name));
    customSkills = customSkills.filter((cs) => selectedSkillNames.has(cs.name) || filterSkillIds.includes(cs.name));
    registeredSkills = registeredSkills.filter((rs) => {
      const name = rs.split(" (")[0];
      return selectedSkillNames.has(name) || filterSkillIds.includes(name);
    });
  }

  let skillsList = "";
  if (clawhubSkills.length > 0 || customSkills.length > 0 || registeredSkills.length > 0) {
    skillsList += `\n\n=== INSTALLED SKILLS ===`;
    skillsList += `\nIMPORTANT: BEFORE answering any user request, scan the skill list below. If a skill's description matches the user's task, you MUST load and use that skill FIRST by calling load_skill("<skill-name>"), then follow its SKILL.md instructions. Do NOT write your own code from scratch when a matching skill exists. Skills contain tested implementations and supporting files (like Python engines) that should be used.`;
  }
  if (customSkills.length > 0) {
    skillsList += `\n\nCustom skills (priority — always prefer these):`;
    for (const cs of customSkills) {
      skillsList += `\n- "${cs.name}"${cs.description ? ": " + cs.description : ""} [files: ${cs.files.join(", ")}]`;
    }
  }
  if (clawhubSkills.length > 0) {
    skillsList += `\n\nClawHub skills: ${clawhubSkills.join(", ")}`;
  }
  if (registeredSkills.length > 0) {
    skillsList += `\n\nOther registered skills: ${registeredSkills.join(", ")}`;
  }
  if (skillsList) {
    skillsList += `\n\nSkill usage workflow: 1) call load_skill("<name>") to read SKILL.md and see supporting files, 2) if the skill has supporting .py/.sh script files listed, use read_file to load them then execute via run_python/run_shell, 3) if the skill has NO supporting script files (only SKILL.md), you MUST implement the logic INLINE in run_python following the SKILL.md instructions — do NOT try to import from non-existent script paths. 4) CRITICAL: if run_python returns empty output, the execution FAILED — report the error to the user, do NOT fabricate results.`;
  }

  const settings = await getSettings();
  const includeAgents = options?.includeAgentConfig ?? false;
  const isManualSubAgent = settings.subAgentEnabled && settings.subAgentMode === "manual";
  const isRealtimeAgent = settings.subAgentEnabled && settings.subAgentMode === "realtime";
  const isAutoSwarm = settings.subAgentEnabled && settings.subAgentMode === "auto_swarm";
  const isAutoCreate = settings.subAgentEnabled && settings.subAgentMode === "auto_create";

  // Mode-specific delegation rules — only include when agents are actually active
  let delegationRules = "";
  if (includeAgents || isAutoCreate || isAutoSwarm) {
    if (isAutoCreate) {
      delegationRules = `
AUTO CREATE ARCHITECTURE MODE: You are the orchestrator. Your workflow is:
1. FIRST: Call create_architecture to design and build an agent team tailored to the user's task. Analyze what the task needs and choose the best architecture type and agents.
2. AFTER CREATION: The created agents will boot in REALTIME mode. Use send_task({to: "<agentId>", task: "..."}) to delegate work, then wait_result({from: "<agentId>"}) to collect results.
3. Do NOT do any work yourself — delegate everything to agents via send_task/wait_result.
4. After all agents return, synthesize their results into a clear final response.
5. If the task changes significantly, you may call create_architecture again to build a new team.`;
    } else if (isRealtimeAgent) {
      delegationRules = `
REALTIME AGENT MODE: All agents are already alive. Delegate ALL work to the agent team via send_task/wait_result.
- If an orchestrator exists, send tasks ONLY to the orchestrator — it manages all sub-delegation.
- Workflow: send_task → wait_result → synthesize response. Only use run_python/write_file for formatting final output.
- Always delegate, even for follow-ups or corrections. Include chat context so agents know what to fix.`;
    } else if (isAutoSwarm) {
      delegationRules = `
AUTO CHOOSE SWARM MODE: You are the orchestrator. Your workflow is:
1. FIRST: Call select_swarm to pick the best agent swarm config from the available list below. Analyze the user's task and match it to the swarm whose description and agents fit best.
2. AFTER SELECTION: The selected agents will boot in REALTIME mode. Use send_task({to: "<agentId>", task: "..."}) to delegate work, then wait_result({from: "<agentId>"}) to collect results.
3. Do NOT do any work yourself — delegate everything to agents via send_task/wait_result.
4. After all agents return, synthesize their results into a clear final response.
5. If the user's task changes significantly, you may call select_swarm again to switch to a different swarm.
6. IMPORTANT: Only use agents defined in the selected YAML architecture. Do NOT invent or create new agents.`;
    } else if (isManualSubAgent) {
      delegationRules = `
MANUAL SUB-AGENT MODE: Delegate ALL tasks via spawn_subagent with agentId matching the YAML config.
- Follow the workflow sequence strictly. Spawn independent downstream agents in parallel.
- Always delegate, even for simple tasks or follow-ups. Include chat context so agents know what to fix.`;
    } else if (settings.subAgentEnabled) {
      delegationRules = `
SUB-AGENTS: Use spawn_subagent for complex multi-part tasks. Each sub-agent runs independently with full tool access.`;
    }
  }

  // SOUL.md & IDENTITY.md — orchestrator behavioral priors
  let soulBlock = "";
  if (settings.orchestratorSoul) {
    soulBlock += `\n\n=== SOUL.md (Internal Cognition & Behavioral Prior) ===\n${settings.orchestratorSoul}`;
  }
  if (settings.orchestratorIdentity) {
    soulBlock += `\n\n=== IDENTITY.md (External Presentation) ===\n${settings.orchestratorIdentity}`;
  }

  return `You are Tigrimos, an AI assistant with tools for search, code execution, files, and skills.
${delegationRules}${soulBlock}

Rules:
- Always use tools to produce real results — never just describe what you would do.
- If a tool call fails, analyze the error, fix it, and retry. Try a different approach after two failures. Never give up.
- Do not call the same tool with identical arguments repeatedly.
- Before writing code, check if an installed skill matches the task. If so, call load_skill first and use its implementation.
- For web search, prefer the duckduckgo-search skill via run_python over web_search. If results are limited, follow up with fetch_url.

Output files:
- Python working directory is output_file/ in the sandbox. Use PROJECT_DIR to access uploaded files (e.g. os.path.join(PROJECT_DIR, 'uploads/file.xlsx')).
- Save charts as .png (plt.savefig, never plt.show). Save reports as .html or .pdf. Use python-docx for .docx files (never write_file for binary formats).
- Generate actual output files — don't just print data. Combine data processing and chart generation in one run_python call when possible.
- For interactive visualizations, use run_react. Globals (React, hooks, Recharts components) are pre-loaded — do not use import/export statements.
- MCP tools (prefixed "mcp_") are available when connected via Settings.${await getLocalMountsPrompt()}${skillsList}${includeAgents ? (await getManualAgentConfigSummary() || "") : ""}`;
}

// Store io reference for broadcasting status to all connected clients
let ioRef: Server | null = null;

// Throttle status broadcasts per session — at most once every 150ms
// Important events (done, job_complete, thinking) bypass the throttle
const statusThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingStatus = new Map<string, Record<string, any>>();
const BYPASS_STATUSES = new Set(["done", "job_complete", "thinking", "retrying"]);

function broadcastStatus(data: Record<string, any>) {
  if (!ioRef) return;
  // Chat log: record tool calls and agent events
  if (data.sessionId && data.status) {
    const sid = data.sessionId as string;
    if (data.status === "tool_call") {
      const argsStr = data.args ? JSON.stringify(data.args, null, 2) : "";
      appendChatLog(sid, `\n[${chatLogTimestamp()}] TOOL_CALL: ${data.tool || "unknown"}${data.label ? ` (${data.label})` : ""}\n${argsStr ? argsStr + "\n" : ""}`);
    } else if (data.status === "tool_result") {
      appendChatLog(sid, `[${chatLogTimestamp()}] TOOL_RESULT: ${data.tool || "unknown"}\n`);
    } else if (data.status === "subagent_spawn") {
      const taskStr = data.task ? `\n  TASK: ${String(data.task).slice(0, 500)}` : "";
      appendChatLog(sid, `\n[${chatLogTimestamp()}] >>> AGENT_SPAWN: ${data.label || data.subagentId || "agent"}${taskStr}\n`);
    } else if (data.status === "subagent_tool") {
      appendChatLog(sid, `[${chatLogTimestamp()}]   ${data.label || "agent"} → tool: ${data.tool}\n`);
    } else if (data.status === "subagent_done") {
      const resultStr = data.result ? `\n${"-".repeat(50)}\nREASONING/RESPONSE:\n${data.result}\n${"-".repeat(50)}` : "";
      appendChatLog(sid, `\n[${chatLogTimestamp()}] <<< AGENT_DONE: ${data.label || data.subagentId || "agent"}${resultStr}\n`);
    } else if (data.status === "subagent_error") {
      appendChatLog(sid, `\n[${chatLogTimestamp()}] !!! AGENT_ERROR: ${data.label || "agent"}: ${data.error || ""}\n`);
    } else if (data.status === "realtime_agent_ready") {
      appendChatLog(sid, `[${chatLogTimestamp()}] AGENT_READY: ${data.label || data.agentId || "agent"}\n`);
    } else if (data.status === "realtime_agent_working") {
      const taskStr = data.task ? `\n  TASK: ${String(data.task).slice(0, 500)}` : "";
      appendChatLog(sid, `\n[${chatLogTimestamp()}] >>> AGENT_WORKING: ${data.label || data.agentId || "agent"}${taskStr}\n`);
    } else if (data.status === "realtime_agent_tool") {
      if (data.tool && data.tool !== "error_recovery") {
        appendChatLog(sid, `[${chatLogTimestamp()}]   ${data.label || "agent"} → tool: ${data.tool}\n`);
      }
    } else if (data.status === "realtime_agent_text" && data.text) {
      appendChatLog(sid, `\n[${chatLogTimestamp()}] ${data.label || "agent"} THINKING:\n${data.text}\n`);
    } else if (data.status === "subagent_text" && data.text) {
      appendChatLog(sid, `\n[${chatLogTimestamp()}] ${data.label || "agent"} THINKING:\n${data.text}\n`);
    } else if (data.status === "realtime_agent_done") {
      const resultStr = data.result ? `\n${"-".repeat(50)}\nFINAL RESPONSE:\n${data.result}\n${"-".repeat(50)}` : "";
      appendChatLog(sid, `\n[${chatLogTimestamp()}] <<< AGENT_COMPLETE: ${data.label || data.agentId || "agent"}${resultStr}\n`);
    } else if (data.status === "running" && data.content) {
      appendChatLog(sid, `[${chatLogTimestamp()}]   ${data.label || "agent"}: ${String(data.content).slice(0, 500)}\n`);
    } else if (data.status === "human_node_message" && data.content) {
      appendChatLog(sid, `\n[${chatLogTimestamp()}] HUMAN_NODE_MESSAGE from ${data.label || data.agentId}:\n${data.content}\n`);
    }
  }
  const key = data.sessionId || "__global__";

  // Important events go through immediately. Blackboard tool events also bypass —
  // bid/award/propose are low-rate but each one carries unique state, so coalescing
  // them via the 150ms throttle would drop winner/task data.
  const isBBToolEvent = typeof data.tool === "string" && data.tool.startsWith("bb_");
  if (BYPASS_STATUSES.has(data.status) || isBBToolEvent) {
    // Flush any pending throttled status first
    if (statusThrottleTimers.has(key)) {
      clearTimeout(statusThrottleTimers.get(key)!);
      statusThrottleTimers.delete(key);
      pendingStatus.delete(key);
    }
    ioRef.emit("chat:status", data);
    return;
  }

  // Throttle: store latest and schedule flush
  pendingStatus.set(key, data);
  if (!statusThrottleTimers.has(key)) {
    statusThrottleTimers.set(key, setTimeout(() => {
      statusThrottleTimers.delete(key);
      const pending = pendingStatus.get(key);
      pendingStatus.delete(key);
      if (pending && ioRef) ioRef.emit("chat:status", pending);
    }, 150));
  }
}

// ─── Activity log: append to a simple log file per session ───
// Instead of flooding React with chat:chunk events for every agent tool call,
// we write to a log file. The frontend polls this file on-demand via the Activity panel.
const ACTIVITY_LOG_DIR = path.resolve("data", "activity_logs");
try { if (!fs.existsSync(ACTIVITY_LOG_DIR)) fs.mkdirSync(ACTIVITY_LOG_DIR, { recursive: true }); } catch {}

function appendSessionProgress(sessionId: string, text: string) {
  try {
    fs.appendFileSync(path.join(ACTIVITY_LOG_DIR, `${sessionId}.log`), text);
  } catch {}
}

// ─── Full Chat Log (records everything: user, AI, tool calls, reasoning) ───
const CHAT_LOG_DIR = path.resolve("data", "chat_logs");
try { if (!fs.existsSync(CHAT_LOG_DIR)) fs.mkdirSync(CHAT_LOG_DIR, { recursive: true }); } catch {}

function appendChatLog(sessionId: string, text: string) {
  try {
    fs.appendFileSync(path.join(CHAT_LOG_DIR, `${sessionId}.log`), text);
  } catch {}
}

function chatLogTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ─── Throttle sub-agent tool events to prevent flooding React ───
const SUBAGENT_TOOL_THROTTLE_MS = 500;
const lastToolEmitTime = new Map<string, number>();
const pendingToolEvents = new Map<string, Record<string, any>>();

function shouldThrottleToolEvent(data: Record<string, any>): boolean {
  const status = data.status as string;
  // Allow lifecycle events through immediately
  if (status === "subagent_spawn" || status === "subagent_done" || status === "subagent_error" ||
      status === "realtime_agent_ready" || status === "realtime_agent_done" ||
      status === "realtime_agent_text" || status === "subagent_text" ||
      status === "done" || status === "human_node_message") return false;
  // Only throttle frequent events: tool calls, working status
  if (!status?.includes("tool") && !status?.includes("working")) return false;

  const agentKey = (data.subagentId || data.label || data.agentId || "main") as string;
  const now = Date.now();
  const lastEmit = lastToolEmitTime.get(agentKey) || 0;

  if (now - lastEmit < SUBAGENT_TOOL_THROTTLE_MS) {
    pendingToolEvents.set(agentKey, data);
    if (!lastToolEmitTime.has(`_timer_${agentKey}`)) {
      const remaining = SUBAGENT_TOOL_THROTTLE_MS - (now - lastEmit);
      setTimeout(() => {
        lastToolEmitTime.delete(`_timer_${agentKey}`);
        const pending = pendingToolEvents.get(agentKey);
        if (pending) {
          pendingToolEvents.delete(agentKey);
          lastToolEmitTime.set(agentKey, Date.now());
          broadcastStatus(pending);
          emitSubagentChunk(pending);
        }
      }, remaining);
      lastToolEmitTime.set(`_timer_${agentKey}`, 1);
    }
    return true;
  }
  lastToolEmitTime.set(agentKey, now);
  return false;
}

// Format status events as markdown and write to activity log file
function emitSubagentChunk(data: Record<string, any>) {
  if (!data.sessionId) return;
  let progressText = "";

  if (data.status === "subagent_spawn") {
    progressText += `> **🔄 Sub-agent "${data.label}"** spawned (depth ${data.depth}) — _${((data.task as string) || "").slice(0, 500)}_\n`;
  } else if (data.status === "subagent_tool") {
    if (data.tool?.startsWith("proto_")) {
      const protoName = (data.tool as string).replace("proto_", "").split("_")[0].toUpperCase();
      progressText = `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> **${data.label}** → \`${data.tool}\`\n`;
    } else {
      progressText = `> **⚙️ ${data.label}** → \`${data.tool}\`\n`;
    }
  } else if (data.status === "subagent_done") {
    progressText = `> **✅ Sub-agent "${data.label}"** completed\n`;
  } else if (data.status === "subagent_error") {
    progressText = `> **❌ Sub-agent "${data.label}"** failed: ${data.error}\n`;
  } else if (data.status === "realtime_agent_ready") {
    progressText += `> **🟢 ${data.label}** (${data.role}) is ready\n`;
  } else if (data.status === "realtime_agent_working") {
    progressText = `> **🔄 ${data.label}** working — _${((data.task as string) || "").slice(0, 500)}_\n`;
  } else if (data.status === "realtime_agent_tool") {
    if (data.tool === "error_recovery") {
      progressText = `> **🔄 ${data.label}** encountered an error — recovering and retrying...\n`;
    } else if (data.tool?.startsWith("proto_")) {
      const protoName = (data.tool as string).replace("proto_", "").split("_")[0].toUpperCase();
      progressText = `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> **${data.label}** → \`${data.tool}\`\n`;
    } else if (data.tool === "send_task") {
      progressText = `> **📤 ${data.label}** delegating task\n`;
    } else if (data.tool === "wait_result") {
      progressText = `> **⏳ ${data.label}** waiting for result\n`;
    } else {
      progressText = `> **⚙️ ${data.label}** → \`${data.tool}\`\n`;
    }
  } else if (data.status === "realtime_agent_tool_done") {
    // silent
  } else if (data.status === "realtime_agent_done") {
    progressText = `> **✅ ${data.label}** task completed\n`;
  } else if (data.status === "running" && data.content) {
    progressText = `> **📡 ${data.label}** — _${(data.content as string).replace(/^\[.*?\]\s*/, "").slice(0, 500)}_\n`;
  } else if (data.status === "done" && data.label) {
    progressText = `> **✅ ${data.label}** remote task completed\n`;
  } else if (data.status === "human_node_message") {
    progressText = `\n<div class="agent-response-tag" data-agent="${data.agentId}">📨 <strong>${data.label}</strong></div>\n\n${data.content}\n`;
  }
  if (progressText) {
    // Write to log file only — do NOT emit chat:chunk to avoid flooding React
    appendSessionProgress(data.sessionId as string, progressText);
  }
}

export function setupSocket(io: Server): void {
  ioRef = io;

  // Track whether swarm tag was already shown per session
  const swarmTagShown = new Set<string>();

  // Wire up sub-agent status broadcasting — throttle tool events, write to activity log file
  setSubagentStatusCallback((data) => {
    if (shouldThrottleToolEvent(data)) return; // throttled — will emit later
    broadcastStatus(data);
    // Update active task agent tracking from subagent/realtime agent events
    if (data.sessionId) {
      const task = Array.from(activeTasks.values()).find(t => t.sessionId === data.sessionId);
      if (task) {
        const agentLabel = data.label || data.agentId || "Agent";
        if (data.status === "subagent_spawn" || data.status === "realtime_agent_working") {
          task.activeAgents.add(agentLabel);
          task.activeAgent = agentLabel;
          if (!task.agentTools[agentLabel]) task.agentTools[agentLabel] = [];
        } else if (data.status === "running" && data.content) {
          task.activeAgents.add(agentLabel);
          task.activeAgent = agentLabel;
          if (!task.agentTools[agentLabel]) task.agentTools[agentLabel] = [];
          const shortContent = data.content.replace(/^\[.*?\]\s*/, "").slice(0, 80);
          pushToolCapped(task.agentTools[agentLabel], `remote:${shortContent}`);
          pushToolCapped(task.toolCalls, "remote_progress");
        } else if ((data.status === "subagent_tool" || data.status === "realtime_agent_tool") && data.tool) {
          task.activeAgents.add(agentLabel);
          task.activeAgent = agentLabel;
          if (!task.agentTools[agentLabel]) task.agentTools[agentLabel] = [];
          pushToolCapped(task.agentTools[agentLabel], data.tool);
          pushToolCapped(task.toolCalls, data.tool);
        } else if (data.status === "subagent_done" || data.status === "realtime_agent_done" || data.status === "done") {
          task.activeAgents.delete(agentLabel);
          task.doneAgents.add(agentLabel);
          if (task.activeAgents.size > 0) {
            task.activeAgent = Array.from(task.activeAgents).join(", ");
          } else {
            task.activeAgent = "Orchestrator";
          }
        }
        task.lastUpdate = new Date().toISOString();
      }
    }
    // Write swarm mode tag to activity log on first agent event
    if (data.sessionId) {
      if (data.status === "subagent_spawn" && !swarmTagShown.has(data.sessionId)) {
        swarmTagShown.add(data.sessionId);
        appendSessionProgress(data.sessionId, `\n<div class="swarm-tag">🐝 SWARM MODE ACTIVE</div>\n\n`);
      }
      if (data.status === "realtime_agent_ready" && !swarmTagShown.has(data.sessionId)) {
        swarmTagShown.add(data.sessionId);
        appendSessionProgress(data.sessionId, `\n<div class="swarm-tag">⚡ REALTIME AGENT MODE</div>\n\n`);
      }
    }
    // Format and write to activity log file (NOT chat:chunk — prevents React flooding)
    emitSubagentChunk(data);
    // Handle human_node_message file saving separately
    if (data.status === "human_node_message" && data.sessionId) {
      const humanMsgFiles: string[] = data.outputFiles || [];
      getSettings().then(async (msgSettings) => {
        const msgSandboxDir = resolveSandboxDir(msgSettings.sandboxDir);
        const scannedMsgFiles = scanOutputFiles(msgSandboxDir, Date.now() - 120000);
        for (const sf of scannedMsgFiles) {
          if (!humanMsgFiles.includes(sf)) humanMsgFiles.push(sf);
        }
        if (humanMsgFiles.length > 0) {
          const sessions = await getChatHistory();
          const session = sessions.find((s) => s.id === data.sessionId);
          if (session) {
            const agentMsg = `<div class="agent-response-tag" data-agent="${data.agentId}">📨 <strong>${data.label}</strong></div>\n\n${data.content}`;
            session.messages.push({
              role: "assistant",
              content: agentMsg,
              timestamp: new Date().toISOString(),
              files: humanMsgFiles,
            });
            await saveChatHistory(sessions);
            ioRef?.emit("chat:response", { sessionId: data.sessionId, content: agentMsg, done: false, files: humanMsgFiles });
          }
        }
      }).catch(() => {});
    }
  });

  io.on("connection", (socket: Socket) => {
    console.log("Client connected:", socket.id);

    // Intercept socket.emit to record chat logs
    const origEmit = socket.emit.bind(socket);
    socket.emit = function(event: string, ...args: any[]) {
      if (event === "chat:response" && args[0]?.sessionId && args[0]?.content && args[0]?.done) {
        const content = args[0].content;
        if (content && content.length > 0) {
          appendChatLog(args[0].sessionId, `\n[${chatLogTimestamp()}] ASSISTANT:\n${content}\n`);
        }
      } else if (event === "chat:chunk" && args[0]?.sessionId && args[0]?.content && !args[0]?.clear) {
        const content = args[0].content;
        // Log agent/protocol tags and significant chunks
        if (content && (content.includes("proto-tag") || content.includes("**") || content.includes("Creating Architecture") || content.includes("Realtime Agents"))) {
          // Strip HTML tags for clean log
          const clean = content.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").trim();
          if (clean) appendChatLog(args[0].sessionId, `[${chatLogTimestamp()}] ${clean}\n`);
        }
      }
      return origEmit(event, ...args);
    } as any;

    // Send active tasks to newly connected client so they can restore progress state
    const active = getActiveTasks();
    if (active.length > 0) {
      for (const task of active) {
        socket.emit("chat:status", {
          sessionId: task.sessionId,
          status: task.status.startsWith("Running:") ? "tool_call" : "thinking",
          tool: task.status.startsWith("Running:") ? task.status.replace("Running: ", "") : undefined,
        });
      }
    }

    socket.on("chat:send", async (data: { sessionId: string; message: string; images?: { path: string; type: string }[] }) => {
      const { sessionId, message, images } = data;
      const sessions = await getChatHistory();
      let session = sessions.find((s) => s.id === sessionId);

      if (!session) {
        session = {
          id: sessionId,
          title: message.slice(0, 50),
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        sessions.push(session);
      }

      session.messages.push({
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      session.updatedAt = new Date().toISOString();
      await saveChatHistory(sessions);

      // Chat log: record user message
      appendChatLog(sessionId, `\n[${chatLogTimestamp()}] USER:\n${message}\n`);

      // ─── /agent command: talk directly to agents in realtime mode ───
      // Format: /agent [agent_name_or_id] "prompt"  OR  /agent "prompt" (broadcast to all connected)
      const agentCmdMatch = message.match(/^\/agent\s+(?:(\S+)\s+)?[""]?([\s\S]+?)[""]?\s*$/i);
      if (agentCmdMatch) {
        const rtSession = getRealtimeSession(sessionId);
        if (!rtSession) {
          const errMsg = "No realtime agent session is active. Start a realtime session first (enable realtime mode in settings with an agent config).";
          session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: errMsg, done: true });
          return;
        }

        const targetArg = agentCmdMatch[1]; // agent name/id or undefined (broadcast)
        const prompt = agentCmdMatch[2].trim();

        if (targetArg) {
          // Find agent by ID or name (case-insensitive)
          const connectedIds = getHumanConnectedAgents(sessionId);
          let targetId: string | undefined;

          // First try exact ID match
          if (rtSession.agents.has(targetArg)) {
            targetId = targetArg;
          } else {
            // Try name match (case-insensitive)
            for (const [id, handle] of rtSession.agents.entries()) {
              if (handle.agentDef.name.toLowerCase() === targetArg.toLowerCase() ||
                  handle.agentDef.id.toLowerCase() === targetArg.toLowerCase()) {
                targetId = id;
                break;
              }
            }
          }

          if (!targetId) {
            const available = Array.from(rtSession.agents.entries())
              .filter(([, h]) => h.agentDef.role !== "human")
              .map(([id, h]) => `${h.agentDef.name} (${id})`)
              .join(", ");
            const errMsg = `Agent "${targetArg}" not found. Available agents: ${available}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Validate human can talk to this agent
          if (connectedIds.length > 0 && !connectedIds.includes(targetId)) {
            const allowedNames = connectedIds.map((id) => {
              const h = rtSession.agents.get(id);
              return h ? `${h.agentDef.name} (${id})` : id;
            }).join(", ");
            const errMsg = `You can only talk to agents connected to the human node: ${allowedNames}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Send task to specific agent
          const agentName = rtSession.agents.get(targetId)!.agentDef.name;
          const agentStartTime = Date.now();
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → **${agentName}** (\`${targetId}\`): _${prompt.slice(0, 500)}_\n`,
          });

          const result = await humanSendToAgent(sessionId, targetId, prompt);
          if (!result.ok) {
            const errMsg = `Failed to send to ${targetId}: ${result.error}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Wait for the agent's result
          socket.emit("chat:chunk", { sessionId, content: `> Waiting for **${agentName}** to respond...\n` });
          const waitResult = await humanWaitForAgent(sessionId, targetId, 120000);
          const responseContent = waitResult.ok
            ? `<div class="agent-response-tag" data-agent="${targetId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`
            : `**${agentName}** did not respond in time: ${waitResult.error}`;

          // Scan for output files generated during agent execution
          const agentSettings = await getSettings();
          const agentSandboxDir = resolveSandboxDir(agentSettings.sandboxDir);
          const agentOutputFiles = scanOutputFiles(agentSandboxDir, agentStartTime);

          session.messages.push({ role: "assistant", content: responseContent, timestamp: new Date().toISOString(), files: agentOutputFiles.length > 0 ? agentOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: responseContent, done: true, files: agentOutputFiles.length > 0 ? agentOutputFiles : undefined });
          return;

        } else {
          // Broadcast to all connected agents
          const connectedIds = getHumanConnectedAgents(sessionId);
          if (connectedIds.length === 0) {
            const errMsg = "No agents are connected to the human node. Add connections from the human node to agents in the Agent Editor.";
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          const agentNames = connectedIds.map((id) => {
            const h = rtSession.agents.get(id);
            return h ? `${h.agentDef.name} (${id})` : id;
          });
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → Broadcasting to **${agentNames.join(", ")}**: _${prompt.slice(0, 500)}_\n`,
          });

          const broadcastStartTime = Date.now();
          const broadcastResult = await humanBroadcastToAgents(sessionId, prompt);
          if (!broadcastResult.ok) {
            const errMsg = `Broadcast failed: ${broadcastResult.errors.join("; ")}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Collect results from all agents concurrently
          socket.emit("chat:chunk", { sessionId, content: `> Waiting for ${broadcastResult.sent.length} agent(s) to respond...\n` });

          const resultPromises = broadcastResult.sent.map(async (agentId) => {
            const agentName = rtSession.agents.get(agentId)?.agentDef.name || agentId;
            const waitResult = await humanWaitForAgent(sessionId, agentId, 120000);
            if (waitResult.ok) {
              return `<div class="agent-response-tag" data-agent="${agentId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`;
            } else {
              return `<div class="agent-response-tag" data-agent="${agentId}">⏱️ <strong>${agentName}</strong> (timeout)</div>\n\n${waitResult.error}`;
            }
          });

          const results = await Promise.all(resultPromises);
          const fullResponse = results.join("\n\n---\n\n");

          // Scan for output files generated during agent execution
          const bcSettings = await getSettings();
          const bcSandboxDir = resolveSandboxDir(bcSettings.sandboxDir);
          const bcOutputFiles = scanOutputFiles(bcSandboxDir, broadcastStartTime);

          session.messages.push({ role: "assistant", content: fullResponse, timestamp: new Date().toISOString(), files: bcOutputFiles.length > 0 ? bcOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: bcOutputFiles.length > 0 ? bcOutputFiles : undefined });
          return;
        }
      }

      // Check if user sent Python code directly
      const pythonMatch = message.match(/```python\n([\s\S]*?)```/);
      if (pythonMatch) {
        const settings = await getSettings();
        const sandboxDir = resolveSandboxDir(settings.sandboxDir);
        broadcastStatus({ sessionId, status: "running_python" });
        const result = await runPython(pythonMatch[1], sandboxDir);
        const resultMsg = [
          result.stdout && `Output:\n\`\`\`\n${result.stdout}\`\`\``,
          result.stderr && `Errors:\n\`\`\`\n${result.stderr}\`\`\``,
          result.outputFiles.length > 0 && `Generated files: ${result.outputFiles.join(", ")}`,
        ].filter(Boolean).join("\n\n");

        const assistantMsg = `Python execution (exit code ${result.exitCode}):\n\n${resultMsg}`;
        session.messages.push({
          role: "assistant",
          content: assistantMsg,
          timestamp: new Date().toISOString(),
          files: result.outputFiles,
        });
        await saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: assistantMsg, done: true, files: result.outputFiles });
        return;
      }

      // Use tool-calling AI loop — build multimodal content for images
      const settings = await getSettings();
      const sandboxDir = resolveSandboxDir(settings.sandboxDir);
      let rawChatMessages = session.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Compact context: compress older messages when session grows large (by count or total size)
      const chatChars = estimateMessagesChars(rawChatMessages);
      if (rawChatMessages.length > COMPRESS_MSG_THRESHOLD || chatChars > COMPRESS_CHAR_THRESHOLD) {
        try {
          const compressed = await compressOlderMessages(
            rawChatMessages as any,
            settings.agentCompressionWindowSize || 10,
            settings.agentCompressionModel
          );
          if (compressed.length < rawChatMessages.length) {
            console.log(`[ChatCompress] Session ${sessionId}: ${rawChatMessages.length} msgs (${(chatChars/1000).toFixed(0)}K chars) → ${compressed.length} msgs`);
            rawChatMessages = compressed as typeof rawChatMessages;
            // Persist compressed messages back to session so it doesn't keep growing
            session.messages = compressed.map((m: any) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              timestamp: new Date().toISOString(),
            }));
            await saveChatHistory(sessions);
          }
        } catch (err: any) {
          console.error(`[ChatCompress] Failed: ${err.message}, falling back to trim`);
        }
      }

      const chatMessages = trimConversationContext(rawChatMessages) as typeof rawChatMessages;

      // If the latest user message has images, convert to multimodal content
      console.log(`[Image] images received:`, images ? JSON.stringify(images) : "none");
      fs.writeFileSync("/tmp/cowork-image-debug.log", `${new Date().toISOString()} images: ${JSON.stringify(images)}\nmessage: ${message.slice(0,200)}\n`, { flag: "a" });
      if (images && images.length > 0) {
        const lastIdx = chatMessages.length - 1;
        const textContent = chatMessages[lastIdx].content;
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text: textContent },
        ];
        for (const img of images) {
          try {
            const imgPath = path.resolve(img.path);
            let imgBuffer = fs.readFileSync(imgPath);
            let mimeType = img.type || "image/png";

            // Compress if larger than 4MB (API limit is 5MB for base64)
            const MAX_SIZE = 4 * 1024 * 1024;
            if (imgBuffer.length > MAX_SIZE) {
              console.log(`[Image] ${img.path} is ${(imgBuffer.length / 1024 / 1024).toFixed(1)}MB, compressing...`);
              try {
                const tmpOut = `/tmp/cowork_resized_${Date.now()}.jpg`;
                const pyBin = settings.pythonPath || "python3";
                execSync(`${pyBin} -c "
from PIL import Image
import sys
img = Image.open('${imgPath.replace(/'/g, "\\'")}')
img.thumbnail((1600, 1600), Image.LANCZOS)
img = img.convert('RGB')
img.save('${tmpOut}', 'JPEG', quality=80)
"`, { timeout: 10000 });
                imgBuffer = fs.readFileSync(tmpOut);
                mimeType = "image/jpeg";
                fs.unlinkSync(tmpOut);
                console.log(`[Image] Compressed to ${(imgBuffer.length / 1024 / 1024).toFixed(1)}MB`);
              } catch (compErr: any) {
                console.error(`[Image] Compression failed:`, compErr.message);
              }
            }

            const base64 = imgBuffer.toString("base64");
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            });
          } catch (err: any) {
            console.error(`[Image] Failed to read ${img.path}:`, err.message);
          }
        }
        (chatMessages[lastIdx] as any).content = contentParts;
      }

      broadcastStatus({ sessionId, status: "thinking" });
      swarmTagShown.delete(sessionId); // Reset swarm tag for new turn
      const toolsUsed: string[] = [];
      const outputFiles: string[] = [];

      // Track active task
      const taskId = uuid();
      const activeTask: ActiveTask = {
        id: taskId,
        sessionId,
        title: message.slice(0, 80),
        status: "Thinking...",
        toolCalls: [],
        activeAgent: undefined,
        activeAgents: new Set(),
        doneAgents: new Set(),
        agentTools: {},
        startedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      activeTasks.set(taskId, activeTask);
      const abortController = new AbortController();
      taskAbortControllers.set(taskId, abortController);

      try {
        // Set call context for sub-agent spawning (per-task, supports parallel execution)
        setCallContext(taskId, sessionId, 0);

        // Boot realtime agents if in realtime mode, auto_swarm with selection, or auto_create with creation
        const rtSettings = await getSettings();
        let realtimeTools: any[] | undefined;
        const autoSwarmConfigFile = rtSettings.subAgentMode === "auto_swarm"
          ? getAutoSwarmSelection(sessionId)
          : undefined;
        let autoCreateConfigFile = rtSettings.subAgentMode === "auto_create"
          ? getAutoCreatedArchitecture(sessionId)
          : undefined;

        // ─── Force create architecture if auto_create mode and no architecture yet ───
        if (rtSettings.subAgentEnabled && rtSettings.subAgentMode === "auto_create" && !autoCreateConfigFile) {
          activeTask.status = "Creating architecture...";
          activeTask.lastUpdate = new Date().toISOString();
          broadcastStatus({ sessionId, status: "tool_call", tool: "create_architecture", args: { description: message } });
          socket.emit("chat:chunk", { sessionId, content: `> **Creating Architecture** for your task...\n\n` });

          try {
            const archResult = await callTool("create_architecture", {
              description: message,
              architectureType: "hierarchical",
              agentCount: "auto",
            }, abortController.signal, taskId);

            if (archResult?.ok) {
              autoCreateConfigFile = archResult.filename;
              activeTask.status = `Architecture "${archResult.systemName}" created (${archResult.mode})`;
              activeTask.lastUpdate = new Date().toISOString();
              socket.emit("chat:chunk", { sessionId, content: `> **${archResult.systemName}** created as \`${archResult.filename}\` — ${archResult.mode} mode, ${archResult.agents?.length || 0} agents\n\n` });
              socket.emit("chat:architecture-created", { sessionId, filename: archResult.filename, systemName: archResult.systemName });
            } else {
              socket.emit("chat:chunk", { sessionId, content: `> Failed to create architecture: ${archResult?.error || "unknown error"}. Falling back to direct response.\n\n` });
            }
          } catch (err: any) {
            socket.emit("chat:chunk", { sessionId, content: `> Architecture creation failed: ${err.message}. Falling back to direct response.\n\n` });
          }
        }

        const realtimeConfigFile = rtSettings.subAgentMode === "realtime"
          ? rtSettings.subAgentConfigFile
          : (autoSwarmConfigFile || autoCreateConfigFile);

        if (rtSettings.subAgentEnabled && realtimeConfigFile) {
          // Check if realtime session already booted (create_architecture boots it)
          let rtSession = getRealtimeSession(sessionId) || null;
          if (!rtSession) {
            rtSession = await startRealtimeSession(sessionId, realtimeConfigFile, abortController.signal);
          }
          if (rtSession) {
            realtimeTools = await getToolsForRealtimeOrchestrator();
            // Notify client that realtime agents are alive
            const agentNames = Array.from(rtSession.agents.values()).map(h => `${h.agentDef.name} (${h.agentDef.id})`);
            socket.emit("chat:chunk", {
              sessionId,
              content: `> **Realtime Agents Active:** ${agentNames.join(", ")}\n\n`,
            });
          }
        }

        // ─── Direct Orchestrator Bypass ───
        // When realtime mode is active and there's an orchestrator agent,
        // skip the Main LLM call and send the user's message directly to the orchestrator.
        // This eliminates the redundant Main LLM "thinking" step that just forwards to orchestrator anyway.
        const bypassConfigFile = realtimeConfigFile || rtSettings.subAgentConfigFile;
        if (realtimeTools && bypassConfigFile) {
          const agentConfig = loadAgentConfig(bypassConfigFile);
          const orchestratorDef = agentConfig?.agents?.find((a: any) => a.role === "orchestrator");
          const rtSession = getRealtimeSession(sessionId);
          if (orchestratorDef && rtSession && rtSession.agents.has(orchestratorDef.id)) {
            const orchId = orchestratorDef.id;
            const orchName = orchestratorDef.name || orchId;

            // Build context from recent chat history for the orchestrator
            const recentContext = chatMessages
              .slice(-6)
              .filter((m: any) => typeof m.content === "string")
              .map((m: any) => `[${m.role}]: ${(m.content as string).slice(0, 500)}`)
              .join("\n");

            activeTask.status = `Delegating directly to ${orchName}...`;
            activeTask.activeAgent = orchName;
            activeTask.lastUpdate = new Date().toISOString();
            broadcastStatus({ sessionId, status: "tool_call", tool: "send_task", args: { to: orchId, task: message } });

            socket.emit("chat:chunk", {
              sessionId,
              content: `> **Direct → ${orchName}** (skipping main LLM)\n\n`,
            });

            // Send task directly to orchestrator via bus
            busPublish(sessionId, "main", `task:${orchId}`, {
              task: message,
              context: recentContext,
              from: "main",
            });

            activeTask.status = `Waiting for ${orchName}...`;
            activeTask.lastUpdate = new Date().toISOString();
            broadcastStatus({ sessionId, status: "tool_call", tool: "wait_result", args: { from: orchId } });

            // Wait for orchestrator result
            const timeout = (rtSettings.subAgentTimeout || 300) * 1000;
            try {
              const resultMsg = await busWaitForMessage(sessionId, `result:${orchId}`, timeout, abortController.signal);
              const orchResult = resultMsg.payload?.result || "(no result)";
              const orchFiles = resultMsg.payload?.outputFiles || [];
              if (orchFiles.length > 0) outputFiles.push(...orchFiles);

              // Also collect pending results from other agents
              const pendingResults = collectPendingResults(sessionId);
              let pendingText = "";
              if (pendingResults.length > 0) {
                pendingText = "\n\n---\n**Agent Results:**\n";
                for (const pr of pendingResults) {
                  pendingText += `\n**${pr.agentName}:**\n${pr.result}\n`;
                  if (pr.outputFiles) outputFiles.push(...pr.outputFiles);
                }
              }

              // Scan sandbox for output files
              const jobSandboxDir = resolveSandboxDir(rtSettings.sandboxDir);
              const scannedFiles = scanOutputFiles(jobSandboxDir, activeTask.startedAt ? new Date(activeTask.startedAt).getTime() : Date.now() - 60000);
              for (const sf of scannedFiles) {
                if (!outputFiles.includes(sf)) outputFiles.push(sf);
              }

              socket.emit("chat:chunk", { sessionId, content: "", clear: true });
              const fullResponse = orchResult + pendingText +
                (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

              session.messages.push({
                role: "assistant",
                content: fullResponse,
                timestamp: new Date().toISOString(),
                files: outputFiles.length > 0 ? outputFiles : undefined,
              });
              await saveChatHistory(sessions);
              socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
              broadcastStatus({ sessionId, status: "job_complete", files: outputFiles.length > 0 ? outputFiles : undefined } as any);

              // Skip the main LLM call — go directly to finally block
              return;
            } catch (err: any) {
              // If direct bypass fails (timeout, abort), fall through to normal LLM call
              console.log(`[DirectBypass] Orchestrator bypass failed: ${err.message}, falling back to main LLM`);
              socket.emit("chat:chunk", { sessionId, content: "", clear: true });
              socket.emit("chat:chunk", {
                sessionId,
                content: `> Direct bypass timed out, falling back to main LLM...\n\n`,
              });
            }
          }
        }

        const lastBBArgs: Record<string, any> = {};
        const result = await callTigerBotWithTools(
          chatMessages,
          await buildSystemPrompt(undefined, { includeAgentConfig: !!realtimeTools || rtSettings.subAgentMode === "auto_create" || rtSettings.subAgentMode === "auto_swarm" }),
          // onToolCall — show status + protocol tags
          (name, args) => {
            toolsUsed.push(name);
            broadcastStatus({ sessionId, status: "tool_call", tool: name, args });
            if (name.startsWith("bb_")) lastBBArgs[name] = args;
            // Tag protocol tool usage in chat
            if (name.startsWith("proto_") && ioRef) {
              const protoName = name.replace("proto_", "").split("_")[0].toUpperCase();
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> \`${name}\` — ${args.topic || args.peer || args.to || ""}\n`,
              });
            }
            // Tag realtime agent tools in chat
            if ((name === "send_task" || name === "wait_result") && ioRef) {
              const targetId = args.to || args.from || "";
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-bus">AGENT</span> \`${name}\` → ${targetId}\n`,
              });
            }
            // Update active task with descriptive status for orchestrator tools
            if (name === "send_task") {
              activeTask.status = `Running: send_task — delegating to ${args.to || "agent"}`;
            } else if (name === "wait_result") {
              activeTask.status = `Running: wait_result — waiting for ${args.from || "agent"}`;
            } else if (name === "check_agents") {
              activeTask.status = `Running: check_agents`;
            } else if (name === "select_swarm") {
              activeTask.status = `Running: select_swarm — choosing ${args.filename || "architecture"}`;
            } else if (name === "create_architecture") {
              activeTask.status = `Running: create_architecture — designing agent team`;
            } else {
              activeTask.status = `Running: ${name}`;
            }
            pushToolCapped(activeTask.toolCalls, name);
            activeTask.activeAgent = "Orchestrator";
            if (!activeTask.agentTools["Orchestrator"]) activeTask.agentTools["Orchestrator"] = [];
            pushToolCapped(activeTask.agentTools["Orchestrator"], name);
            activeTask.lastUpdate = new Date().toISOString();
          },
          // onToolResult — collect output files, show status only
          (name, toolResult) => {
            const extra: any = {};
            if (name === "bb_award" && toolResult?.awardedTo) {
              extra.task_id = lastBBArgs.bb_award?.task_id;
              extra.awarded_to = toolResult.awardedTo;
            } else if (name === "bb_complete") {
              extra.task_id = lastBBArgs.bb_complete?.task_id;
            } else if (name === "bb_propose" && toolResult?.taskId) {
              extra.task_id = toolResult.taskId;
              if (toolResult.awarded_to) extra.awarded_to = toolResult.awarded_to;
            }
            broadcastStatus({ sessionId, status: "tool_result", tool: name, ...extra });
            if (name === "wait_result") {
              activeTask.status = "Agent result received, thinking...";
            } else if (name === "send_task") {
              activeTask.status = "Task delegated, orchestrating...";
            } else if (name === "select_swarm" && toolResult?.ok) {
              activeTask.status = `Swarm "${toolResult.systemName}" selected, delegating...`;
            } else if (name === "create_architecture" && toolResult?.ok) {
              activeTask.status = `Architecture "${toolResult.systemName}" created, delegating...`;
            } else {
              activeTask.status = `${name} done, thinking...`;
            }
            activeTask.lastUpdate = new Date().toISOString();
            if (toolResult?.outputFiles) {
              outputFiles.push(...toolResult.outputFiles);
            }
          },
          abortController.signal,
          realtimeTools,
          undefined, // modelOverride
          sessionId, // for checkpoint & resume
          // onRetry — broadcast retry status to client
          (attempt, maxRetries, error) => {
            const shortErr = error.length > 120 ? error.slice(0, 120) + "..." : error;
            broadcastStatus({ sessionId, status: "retrying", attempt, maxRetries, error: shortErr });
            activeTask.status = `Retrying (${attempt}/${maxRetries})...`;
            activeTask.lastUpdate = new Date().toISOString();
          },
          taskId, // per-task context for parallel execution
          // onAgentText — capture the agent's intermediate reasoning/thinking
          // between tool-call rounds so the chat log shows what it was doing
          // even in single-agent mode.
          (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            appendChatLog(sessionId, `\n[${chatLogTimestamp()}] AGENT THINKING:\n${trimmed}\n`);
          },
        );

        // Scan sandbox for any new output files generated during this job
        const jobSandboxDir = resolveSandboxDir(rtSettings.sandboxDir);
        const scannedFiles = scanOutputFiles(jobSandboxDir, activeTask.startedAt ? new Date(activeTask.startedAt).getTime() : Date.now() - 60000);
        for (const sf of scannedFiles) {
          if (!outputFiles.includes(sf)) outputFiles.push(sf);
        }

        // Collect any pending agent results that arrived after wait_result timed out
        let pendingResultText = "";
        if (realtimeTools) {
          const pendingResults = collectPendingResults(sessionId);
          if (pendingResults.length > 0) {
            pendingResultText = "\n\n---\n**Agent Results:**\n";
            for (const pr of pendingResults) {
              pendingResultText += `\n**${pr.agentName}:**\n${pr.result}\n`;
              if (pr.outputFiles) outputFiles.push(...pr.outputFiles);
            }
          }
        }

        // Clear streaming progress — final response is delivered via chat:response
        socket.emit("chat:chunk", { sessionId, content: "", clear: true });

        const fullResponse = result.content + pendingResultText +
          (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

        session.messages.push({
          role: "assistant",
          content: fullResponse,
          timestamp: new Date().toISOString(),
          files: outputFiles.length > 0 ? outputFiles : undefined,
        });
        await saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        // Notify client the job is complete with files to trigger UI refresh
        broadcastStatus({ sessionId, status: "job_complete", files: outputFiles.length > 0 ? outputFiles : undefined } as any);
      } catch (err: any) {
        // If aborted, don't fallback — just report cancellation
        if (abortController.signal.aborted) {
          const cancelMsg = "Task was cancelled." +
            (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
          session.messages.push({
            role: "assistant",
            content: cancelMsg,
            timestamp: new Date().toISOString(),
            files: outputFiles.length > 0 ? outputFiles : undefined,
          });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: cancelMsg, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        } else {
          // Collect pending agent results even on error — agents may have finished
          let pendingOnError = "";
          {
            const pendingResults = collectPendingResults(sessionId);
            if (pendingResults.length > 0) {
              pendingOnError = "\n\n---\n**Agent Results (collected after error):**\n";
              for (const pr of pendingResults) {
                pendingOnError += `\n**${pr.agentName}:**\n${pr.result}\n`;
                if (pr.outputFiles) outputFiles.push(...pr.outputFiles);
              }
            }
          }
          // Fallback to simple call without tools — still include any outputFiles collected during tool calls
          try {
            const fbSettings = await getSettings();
            const fbHasAgents = fbSettings.subAgentEnabled && ["realtime", "auto_create", "auto_swarm"].includes(fbSettings.subAgentMode || "");
            const result = await callTigerBot(chatMessages, await buildSystemPrompt(undefined, { includeAgentConfig: fbHasAgents }));
            const fallbackContent = result.content + pendingOnError +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: fallbackContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: fallbackContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          } catch (fallbackErr: any) {
            const errMsg = `Error: ${fallbackErr.message || err.message}`;
            const errorContent = errMsg + pendingOnError +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: errorContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errorContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          }
        }
      } finally {
        // Clean up per-task call context
        clearCallContext(taskId);

        // Check if agents are still working — if so, keep monitor alive
        const rtSessionCheck = getRealtimeSession(sessionId);
        const hasHumanNode = rtSessionCheck?.systemConfig?.agents?.some((a: any) => a.role === "human");
        const stillWorking = getWorkingAgents(sessionId);

        if (rtSessionCheck && stillWorking.length > 0) {
          const agentNames = stillWorking.map((a: any) => a.agentName).join(", ");
          console.log(`[Realtime] ${stillWorking.length} agent(s) still working after main loop ended: ${agentNames}`);

          // Update task status so monitor stays visible with meaningful status
          const activeTask = activeTasks.get(taskId);
          if (activeTask) {
            activeTask.status = `Waiting for ${agentNames}...`;
            activeTask.lastUpdate = new Date().toISOString();
          }
          broadcastStatus({ sessionId, status: `Waiting for ${agentNames}...` });

          // Track how many agents still need to report back
          let pendingCount = stillWorking.length;

          const cleanupWhenDone = () => {
            pendingCount--;
            if (pendingCount <= 0) {
              clearTimeout(lateTimeout);
              // All agents finished — now broadcast done and clean up
              broadcastStatus({ sessionId, status: "done" });
              const _ftask = activeTasks.get(taskId);
              if (_ftask) recordFinishedTask(_ftask, "completed");
              activeTasks.delete(taskId);
              taskAbortControllers.delete(taskId);
            } else {
              // Update status with remaining agents
              const remaining = getWorkingAgents(sessionId);
              const remainingNames = remaining.map((a: any) => a.agentName).join(", ") || "agents";
              if (activeTask) {
                activeTask.status = `Waiting for ${remainingNames}...`;
                activeTask.lastUpdate = new Date().toISOString();
              }
              broadcastStatus({ sessionId, status: `Waiting for ${remainingNames}...` });
            }
          };

          // Max timeout — clean up even if agents never respond
          const lateTimeout = setTimeout(() => {
            console.log(`[Realtime] Late-result timeout (5min) for ${sessionId}, cleaning up`);
            broadcastStatus({ sessionId, status: "done" });
            activeTasks.delete(taskId);
            taskAbortControllers.delete(taskId);
          }, 5 * 60 * 1000);

          for (const agent of stillWorking) {
            const unsub = busSubscribe(sessionId, `result:${agent.agentId}`, async (msg) => {
              unsub();
              const lateResult = msg.payload?.result || "(no result)";
              const lateFiles = msg.payload?.outputFiles || [];
              console.log(`[Realtime] Late result from ${agent.agentName}: ${lateResult.slice(0, 200)}`);

              // Stream the late result to the client
              const lateContent = `\n\n---\n**Late Result from ${agent.agentName}:**\n${lateResult}` +
                (lateFiles.length > 0 ? `\n\nGenerated files: ${lateFiles.join(", ")}` : "");
              socket.emit("chat:chunk", { sessionId, content: "", clear: true });
              socket.emit("chat:chunk", { sessionId, content: lateContent });

              // Save to chat history
              try {
                const lateSessions = await getChatHistory();
                const lateSess = lateSessions.find(s => s.id === sessionId);
                if (lateSess) {
                  lateSess.messages.push({
                    role: "assistant",
                    content: lateContent.trim(),
                    timestamp: new Date().toISOString(),
                    files: lateFiles.length > 0 ? lateFiles : undefined,
                  });
                  await saveChatHistory(lateSessions);
                }
              } catch (e: any) {
                console.error(`[Realtime] Failed to save late result:`, e.message);
              }

              // Emit response event so client refreshes messages
              socket.emit("chat:response", { sessionId, content: lateContent.trim(), done: true, files: lateFiles.length > 0 ? lateFiles : undefined, lateResult: true });
              broadcastStatus({ sessionId, status: "job_complete", files: lateFiles.length > 0 ? lateFiles : undefined } as any);

              cleanupWhenDone();
            });
          }
        } else {
          // No agents still working — broadcast done and clean up immediately
          broadcastStatus({ sessionId, status: "done" });
          activeTasks.delete(taskId);
          taskAbortControllers.delete(taskId);
        }
        // Keep realtime session alive between messages so agents retain context
        // for follow-up user requests. Session will be cleaned up on disconnect.
      }
    });

    // ─── Project Chat ───
    socket.on("project:chat:send", async (data: { projectId: string; sessionId: string; message: string; images?: { path: string; type: string }[] }) => {
      const { projectId, sessionId, message, images } = data;
      const projects = await getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (!project) {
        socket.emit("chat:response", { sessionId, content: "Error: Project not found", done: true });
        return;
      }

      // Resolve working folder (handle relative paths)
      // Build per-project agent overrides
      const ao = (project as any).agentOverride;
      const projectSettingsOverrides: any = {};
      if (ao && ao.enabled) {
        projectSettingsOverrides.subAgentEnabled = true;
        if (ao.subAgentMode) projectSettingsOverrides.subAgentMode = ao.subAgentMode;
        if (ao.subAgentConfigFile) projectSettingsOverrides.subAgentConfigFile = ao.subAgentConfigFile;
        if (ao.autoArchitectureType) projectSettingsOverrides.autoArchitectureType = ao.autoArchitectureType;
        if (ao.autoAgentCount) projectSettingsOverrides.autoAgentCount = ao.autoAgentCount;
        if (ao.autoProtocols) projectSettingsOverrides.autoProtocols = ao.autoProtocols;
      }
      // Wrap entire project chat in settings override scope
      const hasOverrides = Object.keys(projectSettingsOverrides).length > 0;
      const runProjectChat = async () => {
      const settings_proj = await getSettings();
      console.log(`[ProjectChat] sessionId=${sessionId} project="${project.name}" hasOverride=${hasOverrides} effectiveMode=${settings_proj.subAgentMode} configFile=${settings_proj.subAgentConfigFile}`);
      const sandboxDir_proj = resolveSandboxDir(settings_proj.sandboxDir);
      let resolvedWorkingFolder = project.workingFolder
        ? (path.isAbsolute(project.workingFolder) ? project.workingFolder : path.join(sandboxDir_proj, project.workingFolder))
        : "";
      // If working folder doesn't exist: for absolute local paths, try to create it;
      // for old/unreachable paths, fall back to sandbox-relative
      if (resolvedWorkingFolder && !fs.existsSync(resolvedWorkingFolder)) {
        if (path.isAbsolute(project.workingFolder)) {
          // Local folder mode — create the directory on the host
          try { fs.mkdirSync(resolvedWorkingFolder, { recursive: true }); } catch {}
        }
        // If still doesn't exist (permissions, etc.), fall back to sandbox
        if (!fs.existsSync(resolvedWorkingFolder)) {
          const fallback = path.join(sandboxDir_proj, path.basename(resolvedWorkingFolder));
          try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
          resolvedWorkingFolder = fallback;
        }
      }

      // Build project-aware system prompt (filter skills to only project-selected ones)
      // Determine if realtime agents will be active for this project chat
      const projSettings = settings_proj;
      const projHasRealtime = projSettings.subAgentEnabled && (
        (projSettings.subAgentMode === "realtime" && !!projSettings.subAgentConfigFile) ||
        projSettings.subAgentMode === "auto_create" ||
        projSettings.subAgentMode === "auto_swarm"
      );
      let projectPrompt = await buildSystemPrompt(
        project.skills && project.skills.length > 0 ? project.skills : undefined,
        { includeAgentConfig: projHasRealtime }
      );

      // Inject custom system prompt if set
      if ((project as any).systemPrompt) {
        projectPrompt += `\n\n--- PROJECT SYSTEM PROMPT ---\n${(project as any).systemPrompt}\n--- END PROJECT SYSTEM PROMPT ---`;
      }

      // Read tiger.md (project instruction file, like CLAUDE.md) from working folder
      let tigerMdContent = "";
      if (resolvedWorkingFolder) {
        const tigerMdPath = path.join(resolvedWorkingFolder, "tiger.md");
        try {
          if (fs.existsSync(tigerMdPath)) {
            tigerMdContent = fs.readFileSync(tigerMdPath, "utf-8");
          }
        } catch (err: any) {
          console.error(`Failed to read tiger.md for project ${project.id}:`, err.message);
        }
      }

      // Inject tiger.md instructions
      if (tigerMdContent) {
        projectPrompt += `\n\n--- PROJECT INSTRUCTIONS (tiger.md) ---\nThe following are project-level instructions from tiger.md. Follow these guidelines when working on this project:\n\n${tigerMdContent}\n--- END PROJECT INSTRUCTIONS ---`;
      }

      // Read project memory fresh from {workingFolder}/memory.md every time
      let projectMemory = "";
      if (resolvedWorkingFolder) {
        const memoryPath = path.join(resolvedWorkingFolder, "memory.md");
        try {
          if (fs.existsSync(memoryPath)) {
            projectMemory = fs.readFileSync(memoryPath, "utf-8");
          }
        } catch (err: any) {
          console.error(`Failed to read memory.md for project ${project.id}:`, err.message);
        }
      }
      // Fallback to stored memory if no file found
      if (!projectMemory && project.memory) {
        projectMemory = project.memory;
      }

      // Inject project memory
      if (projectMemory) {
        projectPrompt += `\n\n--- PROJECT MEMORY (memory.md) ---\nThe user is working in project "${project.name}". Here is the project memory that records key information:\n\n${projectMemory}\n--- END PROJECT MEMORY ---`;
      }

      // Inject project description
      if (project.description) {
        projectPrompt += `\n\nProject description: ${project.description}`;
      }

      // Inject working folder info
      if (resolvedWorkingFolder) {
        const isLocalFolder = path.isAbsolute(project.workingFolder);
        if (isLocalFolder) {
          projectPrompt += `\n\nProject working folder: ${resolvedWorkingFolder} (LOCAL FOLDER on the host machine)
You are working DIRECTLY on the user's local file system at this path. This is NOT a sandbox — changes affect real files on the user's Mac.
- run_python: CWD is set to this folder. PROJECT_DIR also points here. Files you create appear in this folder.
- run_shell: Commands execute in this folder by default. You can run git, npm, etc. directly.
- read_file / write_file / list_files: Relative paths resolve against this folder.
- You have full access to all files in this directory tree.
When the user asks about files, search this folder first.`;
        } else {
          projectPrompt += `\n\nProject working folder: ${resolvedWorkingFolder}\nWhen the user asks about files, search this folder first. Use this folder for reading/writing project files.\nIMPORTANT: All output files (charts, reports, documents, etc.) are saved directly to this project working folder. The Python working directory (os.chdir) is set to this folder. PROJECT_DIR also points to this folder.`;
        }
      }

      // Inject selected skills info
      if (project.skills && project.skills.length > 0) {
        const allSkills = await getSkills();
        const selectedSkills = allSkills.filter((s) => project.skills.includes(s.id));
        if (selectedSkills.length > 0) {
          projectPrompt += `\n\nProject skills (ONLY these skills are available for this project): ${selectedSkills.map((s) => s.name).join(", ")}\nYou MUST use these skills when they match the user's request. These are the only skills loaded for this project.`;
        }
      }

      // Append instruction to auto-record project info
      projectPrompt += `\n\nIMPORTANT: If the user shares project information (tech stack, architecture decisions, conventions, key files, etc.), suggest recording it to the project memory. You can mention "Would you like me to add this to the project memory?"`;

      // Reuse the same chat session logic
      const sessions = await getChatHistory();
      let session = sessions.find((s) => s.id === sessionId);

      if (!session) {
        session = {
          id: sessionId,
          title: `[${project.name}] ${message.slice(0, 40)}`,
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        sessions.push(session);
      }

      session.messages.push({
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      session.updatedAt = new Date().toISOString();
      await saveChatHistory(sessions);

      // Chat log: record user message
      appendChatLog(sessionId, `\n[${chatLogTimestamp()}] USER (${project.name}):\n${message}\n`);

      // ─── /agent command in project chat ───
      const agentCmdMatchProj = message.match(/^\/agent\s+(?:(\S+)\s+)?[""]?([\s\S]+?)[""]?\s*$/i);
      if (agentCmdMatchProj) {
        const rtSession = getRealtimeSession(sessionId);
        if (!rtSession) {
          const errMsg = "No realtime agent session is active for this project.";
          session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: errMsg, done: true });
          return;
        }

        const targetArg = agentCmdMatchProj[1];
        const prompt = agentCmdMatchProj[2].trim();

        if (targetArg) {
          const connectedIds = getHumanConnectedAgents(sessionId);
          let targetId: string | undefined;
          if (rtSession.agents.has(targetArg)) {
            targetId = targetArg;
          } else {
            for (const [id, handle] of rtSession.agents.entries()) {
              if (handle.agentDef.name.toLowerCase() === targetArg.toLowerCase() ||
                  handle.agentDef.id.toLowerCase() === targetArg.toLowerCase()) {
                targetId = id;
                break;
              }
            }
          }

          if (!targetId) {
            const available = Array.from(rtSession.agents.entries())
              .filter(([, h]) => h.agentDef.role !== "human")
              .map(([id, h]) => `${h.agentDef.name} (${id})`)
              .join(", ");
            const errMsg = `Agent "${targetArg}" not found. Available: ${available}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          if (connectedIds.length > 0 && !connectedIds.includes(targetId)) {
            const allowedNames = connectedIds.map((id) => rtSession.agents.get(id)?.agentDef.name || id).join(", ");
            const errMsg = `You can only talk to agents connected to the human node: ${allowedNames}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          const agentName = rtSession.agents.get(targetId)!.agentDef.name;
          const projAgentStartTime = Date.now();
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → **${agentName}** (\`${targetId}\`): _${prompt.slice(0, 500)}_\n`,
          });

          const result = await humanSendToAgent(sessionId, targetId, prompt);
          if (!result.ok) {
            const errMsg = `Failed: ${result.error}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          socket.emit("chat:chunk", { sessionId, content: `> Waiting for **${agentName}**...\n` });
          const waitResult = await humanWaitForAgent(sessionId, targetId, 120000);
          const responseContent = waitResult.ok
            ? `<div class="agent-response-tag" data-agent="${targetId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`
            : `**${agentName}** did not respond: ${waitResult.error}`;

          // Scan for output files generated during agent execution
          const projAgentSettings = await getSettings();
          const projAgentSandboxDir = resolveSandboxDir(projAgentSettings.sandboxDir);
          const projAgentOutputFiles = scanOutputFiles(projAgentSandboxDir, projAgentStartTime);

          session.messages.push({ role: "assistant", content: responseContent, timestamp: new Date().toISOString(), files: projAgentOutputFiles.length > 0 ? projAgentOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: responseContent, done: true, files: projAgentOutputFiles.length > 0 ? projAgentOutputFiles : undefined });
          return;

        } else {
          const connectedIds = getHumanConnectedAgents(sessionId);
          if (connectedIds.length === 0) {
            const errMsg = "No agents connected to human node.";
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          const agentNames = connectedIds.map((id) => rtSession.agents.get(id)?.agentDef.name || id);
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → Broadcasting to **${agentNames.join(", ")}**: _${prompt.slice(0, 500)}_\n`,
          });

          const projBcStartTime = Date.now();
          const broadcastResult = await humanBroadcastToAgents(sessionId, prompt);
          if (!broadcastResult.ok) {
            const errMsg = `Broadcast failed: ${broadcastResult.errors.join("; ")}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          socket.emit("chat:chunk", { sessionId, content: `> Waiting for ${broadcastResult.sent.length} agent(s)...\n` });
          const results = await Promise.all(
            broadcastResult.sent.map(async (agentId) => {
              const agentName = rtSession.agents.get(agentId)?.agentDef.name || agentId;
              const waitResult = await humanWaitForAgent(sessionId, agentId, 120000);
              return waitResult.ok
                ? `<div class="agent-response-tag" data-agent="${agentId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`
                : `<div class="agent-response-tag" data-agent="${agentId}">⏱️ <strong>${agentName}</strong> (timeout)</div>\n\n${waitResult.error}`;
            })
          );

          const fullResponse = results.join("\n\n---\n\n");

          // Scan for output files generated during agent execution
          const projBcSettings = await getSettings();
          const projBcSandboxDir = resolveSandboxDir(projBcSettings.sandboxDir);
          const projBcOutputFiles = scanOutputFiles(projBcSandboxDir, projBcStartTime);

          session.messages.push({ role: "assistant", content: fullResponse, timestamp: new Date().toISOString(), files: projBcOutputFiles.length > 0 ? projBcOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: projBcOutputFiles.length > 0 ? projBcOutputFiles : undefined });
          return;
        }
      }

      const settings = await getSettings();
      let rawChatMessages2 = session.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Compact context: compress older messages when session grows large (by count or total size)
      const chatChars2 = estimateMessagesChars(rawChatMessages2);
      if (rawChatMessages2.length > COMPRESS_MSG_THRESHOLD || chatChars2 > COMPRESS_CHAR_THRESHOLD) {
        try {
          const compressed = await compressOlderMessages(
            rawChatMessages2 as any,
            settings.agentCompressionWindowSize || 10,
            settings.agentCompressionModel
          );
          if (compressed.length < rawChatMessages2.length) {
            console.log(`[ChatCompress] Project session ${sessionId}: ${rawChatMessages2.length} msgs (${(chatChars2/1000).toFixed(0)}K chars) → ${compressed.length} msgs`);
            rawChatMessages2 = compressed as typeof rawChatMessages2;
            session.messages = compressed.map((m: any) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              timestamp: new Date().toISOString(),
            }));
            await saveChatHistory(sessions);
          }
        } catch (err: any) {
          console.error(`[ChatCompress] Failed: ${err.message}, falling back to trim`);
        }
      }

      const chatMessages = trimConversationContext(rawChatMessages2) as typeof rawChatMessages2;

      // Handle images same as regular chat
      if (images && images.length > 0) {
        const lastIdx = chatMessages.length - 1;
        const textContent = chatMessages[lastIdx].content;
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text: textContent },
        ];
        for (const img of images) {
          try {
            const imgPath = path.resolve(img.path);
            let imgBuffer = fs.readFileSync(imgPath);
            let mimeType = img.type || "image/png";
            const MAX_SIZE = 4 * 1024 * 1024;
            if (imgBuffer.length > MAX_SIZE) {
              try {
                const tmpOut = `/tmp/cowork_resized_${Date.now()}.jpg`;
                const pyBin = settings.pythonPath || "python3";
                execSync(`${pyBin} -c "
from PIL import Image
img = Image.open('${imgPath.replace(/'/g, "\\'")}')
img.thumbnail((1600, 1600), Image.LANCZOS)
img = img.convert('RGB')
img.save('${tmpOut}', 'JPEG', quality=80)
"`, { timeout: 10000 });
                imgBuffer = fs.readFileSync(tmpOut);
                mimeType = "image/jpeg";
                fs.unlinkSync(tmpOut);
              } catch {}
            }
            const base64 = imgBuffer.toString("base64");
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            });
          } catch {}
        }
        (chatMessages[lastIdx] as any).content = contentParts;
      }

      broadcastStatus({ sessionId, status: "thinking" });
      const outputFiles: string[] = [];

      // Track active task for project chat
      const taskId = uuid();
      const activeTask: ActiveTask = {
        id: taskId,
        sessionId,
        projectId,
        projectName: project.name,
        title: message.slice(0, 80),
        status: "Thinking...",
        toolCalls: [],
        activeAgent: undefined,
        activeAgents: new Set(),
        doneAgents: new Set(),
        agentTools: {},
        startedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      activeTasks.set(taskId, activeTask);
      const abortController = new AbortController();
      taskAbortControllers.set(taskId, abortController);

      try {
        // Set call context for sub-agent spawning — pass project working folder so output goes there
        setCallContext(taskId, sessionId, 0, undefined, resolvedWorkingFolder || undefined);

        // Boot realtime agents — re-use project-overridden settings
        const rtSettings = projSettings;
        console.log(`[ProjectChat] rtSettings.subAgentMode=${rtSettings.subAgentMode} configFile=${rtSettings.subAgentConfigFile} enabled=${rtSettings.subAgentEnabled}`);
        let realtimeTools: any[] | undefined;
        const projAutoSwarmConfig = rtSettings.subAgentMode === "auto_swarm"
          ? getAutoSwarmSelection(sessionId)
          : undefined;
        let projAutoCreateConfig = rtSettings.subAgentMode === "auto_create"
          ? getAutoCreatedArchitecture(sessionId)
          : undefined;

        // ─── Force create architecture if auto_create mode and no architecture yet ───
        if (rtSettings.subAgentEnabled && rtSettings.subAgentMode === "auto_create" && !projAutoCreateConfig) {
          activeTask.status = "Creating architecture...";
          activeTask.lastUpdate = new Date().toISOString();
          broadcastStatus({ sessionId, status: "tool_call", tool: "create_architecture", args: { description: message } });
          socket.emit("chat:chunk", { sessionId, content: `> **Creating Architecture** for your task...\n\n` });

          try {
            const archResult = await callTool("create_architecture", {
              description: message,
              architectureType: "hierarchical",
              agentCount: "auto",
            }, abortController.signal, taskId);

            if (archResult?.ok) {
              projAutoCreateConfig = archResult.filename;
              activeTask.status = `Architecture "${archResult.systemName}" created (${archResult.mode})`;
              activeTask.lastUpdate = new Date().toISOString();
              socket.emit("chat:chunk", { sessionId, content: `> **${archResult.systemName}** created as \`${archResult.filename}\` — ${archResult.mode} mode, ${archResult.agents?.length || 0} agents\n\n` });
              socket.emit("chat:architecture-created", { sessionId, filename: archResult.filename, systemName: archResult.systemName });
            } else {
              socket.emit("chat:chunk", { sessionId, content: `> Failed to create architecture: ${archResult?.error || "unknown error"}. Falling back to direct response.\n\n` });
            }
          } catch (err: any) {
            socket.emit("chat:chunk", { sessionId, content: `> Architecture creation failed: ${err.message}. Falling back to direct response.\n\n` });
          }
        }

        const projRealtimeConfigFile = rtSettings.subAgentMode === "realtime"
          ? rtSettings.subAgentConfigFile
          : (projAutoSwarmConfig || projAutoCreateConfig);

        if (rtSettings.subAgentEnabled && projRealtimeConfigFile) {
          let rtSession = getRealtimeSession(sessionId) || null;
          if (!rtSession) {
            rtSession = await startRealtimeSession(sessionId, projRealtimeConfigFile, abortController.signal);
          }
          if (rtSession) {
            realtimeTools = await getToolsForRealtimeOrchestrator();
            const agentNames = Array.from(rtSession.agents.values()).map(h => `${h.agentDef.name} (${h.agentDef.id})`);
            socket.emit("chat:chunk", {
              sessionId,
              content: `> **Realtime Agents Active:** ${agentNames.join(", ")}\n\n`,
            });
          }
        }

        // ─── Direct Orchestrator Bypass (Project Chat) ───
        const projBypassConfigFile = projRealtimeConfigFile || rtSettings.subAgentConfigFile;
        if (realtimeTools && projBypassConfigFile) {
          const agentConfig = loadAgentConfig(projBypassConfigFile);
          const orchestratorDef = agentConfig?.agents?.find((a: any) => a.role === "orchestrator");
          const rtSession = getRealtimeSession(sessionId);
          if (orchestratorDef && rtSession && rtSession.agents.has(orchestratorDef.id)) {
            const orchId = orchestratorDef.id;
            const orchName = orchestratorDef.name || orchId;

            const recentContext = chatMessages
              .slice(-6)
              .filter((m: any) => typeof m.content === "string")
              .map((m: any) => `[${m.role}]: ${(m.content as string).slice(0, 500)}`)
              .join("\n");

            activeTask.status = `Delegating directly to ${orchName}...`;
            activeTask.activeAgent = orchName;
            activeTask.lastUpdate = new Date().toISOString();
            broadcastStatus({ sessionId, status: "tool_call", tool: "send_task", args: { to: orchId, task: message } });

            socket.emit("chat:chunk", {
              sessionId,
              content: `> **Direct → ${orchName}** (skipping main LLM)\n\n`,
            });

            busPublish(sessionId, "main", `task:${orchId}`, {
              task: message,
              context: recentContext,
              from: "main",
            });

            activeTask.status = `Waiting for ${orchName}...`;
            activeTask.lastUpdate = new Date().toISOString();
            broadcastStatus({ sessionId, status: "tool_call", tool: "wait_result", args: { from: orchId } });

            const timeout = (rtSettings.subAgentTimeout || 300) * 1000;
            try {
              const resultMsg = await busWaitForMessage(sessionId, `result:${orchId}`, timeout, abortController.signal);
              const orchResult = resultMsg.payload?.result || "(no result)";
              const orchFiles = resultMsg.payload?.outputFiles || [];
              if (orchFiles.length > 0) outputFiles.push(...orchFiles);

              const pendingResults = collectPendingResults(sessionId);
              let pendingText = "";
              if (pendingResults.length > 0) {
                pendingText = "\n\n---\n**Agent Results:**\n";
                for (const pr of pendingResults) {
                  pendingText += `\n**${pr.agentName}:**\n${pr.result}\n`;
                  if (pr.outputFiles) outputFiles.push(...pr.outputFiles);
                }
              }

              const projJobSandboxDir = resolveSandboxDir(rtSettings.sandboxDir);
              const scannedFiles = scanOutputFiles(projJobSandboxDir, activeTask.startedAt ? new Date(activeTask.startedAt).getTime() : Date.now() - 60000);
              for (const sf of scannedFiles) {
                if (!outputFiles.includes(sf)) outputFiles.push(sf);
              }

              socket.emit("chat:chunk", { sessionId, content: "", clear: true });
              const fullResponse = orchResult + pendingText +
                (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

              session.messages.push({
                role: "assistant",
                content: fullResponse,
                timestamp: new Date().toISOString(),
                files: outputFiles.length > 0 ? outputFiles : undefined,
              });
              await saveChatHistory(sessions);
              socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
              broadcastStatus({ sessionId, status: "job_complete", files: outputFiles.length > 0 ? outputFiles : undefined } as any);
              return;
            } catch (err: any) {
              console.log(`[DirectBypass] Project orchestrator bypass failed: ${err.message}, falling back to main LLM`);
              socket.emit("chat:chunk", { sessionId, content: "", clear: true });
              socket.emit("chat:chunk", {
                sessionId,
                content: `> Direct bypass timed out, falling back to main LLM...\n\n`,
              });
            }
          }
        }

        const lastBBArgs: Record<string, any> = {};
        const result = await callTigerBotWithTools(
          chatMessages,
          projectPrompt,
          (name, args) => {
            broadcastStatus({ sessionId, status: "tool_call", tool: name, args });
            if (name.startsWith("bb_")) lastBBArgs[name] = args;
            // Tag protocol tool usage in chat
            if (name.startsWith("proto_") && ioRef) {
              const protoName = name.replace("proto_", "").split("_")[0].toUpperCase();
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> \`${name}\` — ${args.topic || args.peer || args.to || ""}\n`,
              });
            }
            // Tag realtime agent tools in chat
            if ((name === "send_task" || name === "wait_result") && ioRef) {
              const targetId = args.to || args.from || "";
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-bus">AGENT</span> \`${name}\` → ${targetId}\n`,
              });
            }
            // Descriptive active task status for orchestrator tools
            if (name === "send_task") {
              activeTask.status = `Running: send_task — delegating to ${args.to || "agent"}`;
            } else if (name === "wait_result") {
              activeTask.status = `Running: wait_result — waiting for ${args.from || "agent"}`;
            } else if (name === "check_agents") {
              activeTask.status = `Running: check_agents`;
            } else if (name === "select_swarm") {
              activeTask.status = `Running: select_swarm — choosing ${args.filename || "architecture"}`;
            } else if (name === "create_architecture") {
              activeTask.status = `Running: create_architecture — designing agent team`;
            } else {
              activeTask.status = `Running: ${name}`;
            }
            pushToolCapped(activeTask.toolCalls, name);
            activeTask.activeAgent = "Orchestrator";
            if (!activeTask.agentTools["Orchestrator"]) activeTask.agentTools["Orchestrator"] = [];
            pushToolCapped(activeTask.agentTools["Orchestrator"], name);
            activeTask.lastUpdate = new Date().toISOString();
          },
          (name, toolResult) => {
            const extra: any = {};
            if (name === "bb_award" && toolResult?.awardedTo) {
              extra.task_id = lastBBArgs.bb_award?.task_id;
              extra.awarded_to = toolResult.awardedTo;
            } else if (name === "bb_complete") {
              extra.task_id = lastBBArgs.bb_complete?.task_id;
            } else if (name === "bb_propose" && toolResult?.taskId) {
              extra.task_id = toolResult.taskId;
              if (toolResult.awarded_to) extra.awarded_to = toolResult.awarded_to;
            }
            broadcastStatus({ sessionId, status: "tool_result", tool: name, ...extra });
            if (name === "wait_result") {
              activeTask.status = "Agent result received, thinking...";
            } else if (name === "send_task") {
              activeTask.status = "Task delegated, orchestrating...";
            } else if (name === "select_swarm" && toolResult?.ok) {
              activeTask.status = `Swarm "${toolResult.systemName}" selected, delegating...`;
            } else if (name === "create_architecture" && toolResult?.ok) {
              activeTask.status = `Architecture "${toolResult.systemName}" created, delegating...`;
            } else {
              activeTask.status = `${name} done, thinking...`;
            }
            activeTask.lastUpdate = new Date().toISOString();
            if (toolResult?.outputFiles) outputFiles.push(...toolResult.outputFiles);
          },
          abortController.signal,
          realtimeTools,
          undefined, // modelOverride
          sessionId, // for checkpoint & resume
          // onRetry — broadcast retry status to client
          (attempt, maxRetries, error) => {
            const shortErr = error.length > 120 ? error.slice(0, 120) + "..." : error;
            broadcastStatus({ sessionId, status: "retrying", attempt, maxRetries, error: shortErr });
            activeTask.status = `Retrying (${attempt}/${maxRetries})...`;
            activeTask.lastUpdate = new Date().toISOString();
          },
          taskId, // per-task context for parallel execution
          // onAgentText — capture single-agent reasoning/thinking between tool rounds
          (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            appendChatLog(sessionId, `\n[${chatLogTimestamp()}] AGENT THINKING:\n${trimmed}\n`);
          },
        );

        // Scan sandbox for any new output files generated during this job
        const projJobSandboxDir = resolveSandboxDir(rtSettings.sandboxDir);
        const projScannedFiles = scanOutputFiles(projJobSandboxDir, activeTask.startedAt ? new Date(activeTask.startedAt).getTime() : Date.now() - 60000);
        for (const sf of projScannedFiles) {
          if (!outputFiles.includes(sf)) outputFiles.push(sf);
        }

        // Collect any pending agent results that arrived after wait_result timed out
        let projPendingText = "";
        if (realtimeTools) {
          const pendingResults = collectPendingResults(sessionId);
          if (pendingResults.length > 0) {
            projPendingText = "\n\n---\n**Agent Results:**\n";
            for (const pr of pendingResults) {
              projPendingText += `\n**${pr.agentName}:**\n${pr.result}\n`;
              if (pr.outputFiles) outputFiles.push(...pr.outputFiles);
            }
          }
        }

        // Clear streaming progress — final response is delivered via chat:response
        socket.emit("chat:chunk", { sessionId, content: "", clear: true });

        const fullResponse = result.content + projPendingText +
          (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

        session.messages.push({
          role: "assistant",
          content: fullResponse,
          timestamp: new Date().toISOString(),
          files: outputFiles.length > 0 ? outputFiles : undefined,
        });
        await saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        // Notify client the job is complete with files to trigger UI refresh
        broadcastStatus({ sessionId, status: "job_complete", files: outputFiles.length > 0 ? outputFiles : undefined } as any);
      } catch (err: any) {
        if (abortController.signal.aborted) {
          const cancelMsg = "Task was cancelled." +
            (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
          session.messages.push({
            role: "assistant",
            content: cancelMsg,
            timestamp: new Date().toISOString(),
            files: outputFiles.length > 0 ? outputFiles : undefined,
          });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: cancelMsg, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        } else {
          // Collect pending agent results even on error
          let projPendingOnError = "";
          {
            const pendingResults = collectPendingResults(sessionId);
            if (pendingResults.length > 0) {
              projPendingOnError = "\n\n---\n**Agent Results (collected after error):**\n";
              for (const pr of pendingResults) {
                projPendingOnError += `\n**${pr.agentName}:**\n${pr.result}\n`;
                if (pr.outputFiles) outputFiles.push(...pr.outputFiles);
              }
            }
          }
          try {
            const result = await callTigerBot(chatMessages, projectPrompt);
            const fallbackContent = result.content + projPendingOnError +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: fallbackContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: fallbackContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          } catch (fallbackErr: any) {
            const errMsg = `Error: ${fallbackErr.message || err.message}`;
            const errorContent = errMsg + projPendingOnError +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: errorContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errorContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          }
        }
      } finally {
        // Clean up per-task call context
        clearCallContext(taskId);

        // Broadcast "done" so client clears active dot for this session
        broadcastStatus({ sessionId, status: "done" });

        // Check if agents are still working — set up late-result listeners
        const rtSessionCheck2 = getRealtimeSession(sessionId);
        const hasHumanNode2 = rtSessionCheck2?.systemConfig?.agents?.some((a: any) => a.role === "human");
        const stillWorking2 = getWorkingAgents(sessionId);

        if (rtSessionCheck2 && stillWorking2.length > 0) {
          console.log(`[Realtime] ${stillWorking2.length} agent(s) still working after project chat ended, setting up late-result listeners`);

          const lateTimeout2 = setTimeout(() => {
            console.log(`[Realtime] Late-result timeout (5min) for project ${sessionId}`);
            // Don't shutdown — keep agents alive for follow-up messages
          }, 5 * 60 * 1000);

          for (const agent of stillWorking2) {
            const unsub = busSubscribe(sessionId, `result:${agent.agentId}`, async (msg) => {
              unsub();
              const lateResult = msg.payload?.result || "(no result)";
              const lateFiles = msg.payload?.outputFiles || [];
              console.log(`[Realtime] Late result from ${agent.agentName}: ${lateResult.slice(0, 200)}`);

              const lateContent = `\n\n---\n**Late Result from ${agent.agentName}:**\n${lateResult}` +
                (lateFiles.length > 0 ? `\n\nGenerated files: ${lateFiles.join(", ")}` : "");
              socket.emit("chat:chunk", { sessionId, content: "", clear: true });
              socket.emit("chat:chunk", { sessionId, content: lateContent });

              try {
                const lateSessions = await getChatHistory();
                const lateSess = lateSessions.find(s => s.id === sessionId);
                if (lateSess) {
                  lateSess.messages.push({
                    role: "assistant",
                    content: lateContent.trim(),
                    timestamp: new Date().toISOString(),
                    files: lateFiles.length > 0 ? lateFiles : undefined,
                  });
                  await saveChatHistory(lateSessions);
                }
              } catch (e: any) {
                console.error(`[Realtime] Failed to save late result:`, e.message);
              }

              socket.emit("chat:response", { sessionId, content: lateContent.trim(), done: true, files: lateFiles.length > 0 ? lateFiles : undefined, lateResult: true });
              broadcastStatus({ sessionId, status: "job_complete", files: lateFiles.length > 0 ? lateFiles : undefined } as any);

              clearTimeout(lateTimeout2);
            });
          }
        }
        // Keep realtime session alive between messages for follow-up delegation

        const _projFinTask = activeTasks.get(taskId);
        if (_projFinTask) recordFinishedTask(_projFinTask, "completed");
        activeTasks.delete(taskId);
        taskAbortControllers.delete(taskId);
      }
      }; // end runProjectChat

      // Execute with or without settings override
      // AsyncLocalStorage.run() propagates the store through all async operations within the callback
      if (hasOverrides) {
        await runWithSettingsOverride(projectSettingsOverrides, runProjectChat);
      } else {
        await runProjectChat();
      }
    });

    socket.on("python:run", async (data: { code: string }) => {
      const settings = await getSettings();
      const sandboxDir = resolveSandboxDir(settings.sandboxDir);
      socket.emit("python:status", { status: "running" });
      const result = await runPython(data.code, sandboxDir);
      socket.emit("python:result", result);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });
}
