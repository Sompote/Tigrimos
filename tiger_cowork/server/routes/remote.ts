/**
 * Remote Task Routes — handle incoming tasks from other TigrimOS instances.
 *
 * When remoteAgentConfig is set, incoming tasks are processed through the
 * realtime agent system (swarm). Otherwise, they fall back to simple chat.
 *
 * Endpoints:
 *   POST /api/remote/task          — submit a task, returns { taskId }
 *   GET  /api/remote/task/:id      — poll for result + progress
 *   GET  /api/remote/tasks         — list all remote tasks (for UI display)
 */

import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { getSettings, getChatHistory, saveChatHistory, ChatSession } from "../services/data";
import { callTigerBotWithTools } from "../services/tigerbot";

const CHAT_LOG_DIR = path.resolve("data", "chat_logs");
try { if (!fs.existsSync(CHAT_LOG_DIR)) fs.mkdirSync(CHAT_LOG_DIR, { recursive: true }); } catch {}
function appendChatLog(sessionId: string, text: string) {
  try { fs.appendFileSync(path.join(CHAT_LOG_DIR, `${sessionId}.log`), text); } catch {}
}
function chatLogTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
import {
  startRealtimeSession,
  shutdownRealtimeSession,
  getRealtimeSession,
  loadAgentConfig,
  humanSendToAgent,
  humanBroadcastToAgents,
  getHumanConnectedAgents,
  getWorkingAgents,
} from "../services/toolbox";
import { busPublish, busWaitForMessage } from "../services/protocols";
import { buildSystemPrompt } from "../services/socket";

interface RemoteTaskEntry {
  taskId: string;
  sessionId: string;
  status: "running" | "completed" | "error";
  progress: string[];       // timestamped progress messages (trimmed in memory)
  progressSeq: number;      // monotonic counter — increments on every addProgress call, never resets. Clients watch this (or updatedAt) for idle detection so in-memory trimming of `progress` doesn't cause length regressions.
  result?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  abortController?: AbortController;
  killed?: boolean;
  // Agent tracking for diagram/graphic views
  agentTools: Record<string, string[]>;
  activeAgents: Set<string>;
  doneAgents: Set<string>;
}

// In-memory registry of active remote tasks
const remoteTasks = new Map<string, RemoteTaskEntry>();

// Cleanup old tasks after 10 min, and force-expire stuck "running" tasks after 1 hour
setInterval(() => {
  const cleanupCutoff = Date.now() - 10 * 60 * 1000;
  const stuckCutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, entry] of remoteTasks) {
    if (entry.status !== "running" && entry.updatedAt < cleanupCutoff) {
      remoteTasks.delete(id);
    } else if (entry.status === "running" && entry.startedAt < stuckCutoff) {
      entry.status = "error";
      entry.error = "Task stuck — force-expired after 1 hour";
      entry.result = undefined;
      remoteTasks.delete(id);
    }
  }
}, 60_000);

const MAX_PROGRESS = 200;

function addProgress(entry: RemoteTaskEntry, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  if (entry.progress.length >= MAX_PROGRESS) {
    // Keep first 5 (startup context) + trim oldest in the middle
    entry.progress.splice(5, 50);
  }
  entry.progress.push(`[${ts}] ${msg}`);
  entry.progressSeq += 1;
  entry.updatedAt = Date.now();
}

export async function remoteRoutes(fastify: FastifyInstance) {

  // Submit a remote task
  fastify.post("/task", async (request, reply) => {
    const settings = await getSettings();
    if (!settings.remoteEnabled) {
      reply.code(403);
      return { error: "Remote agent is disabled on this instance" };
    }

    const { task } = request.body as any;
    if (!task || typeof task !== "string") {
      reply.code(400);
      return { error: "task (string) is required" };
    }

    const taskId = uuid();
    const sessionId = `remote-${taskId}`;
    const configFile = settings.remoteAgentConfig || "";

    const entry: RemoteTaskEntry = {
      taskId,
      sessionId,
      status: "running",
      progress: [],
      progressSeq: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      abortController: new AbortController(),
      agentTools: {},
      activeAgents: new Set(),
      doneAgents: new Set(),
    };
    remoteTasks.set(taskId, entry);

    // Create a chat session to persist conversation
    const sessions = await getChatHistory();
    const chatSession: ChatSession = {
      id: sessionId,
      title: `Remote task: ${task.slice(0, 60)}`,
      messages: [{ role: "user", content: task, timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.push(chatSession);
    await saveChatHistory(sessions);

    // Run the task asynchronously
    processRemoteTask(entry, task, configFile, settings).catch((err) => {
      entry.status = "error";
      entry.error = err.message;
      addProgress(entry, `Fatal error: ${err.message}`);
    });

    return { taskId, sessionId };
  });

  // List all remote tasks (most recent first) — used by the UI task menu
  fastify.get("/tasks", async () => {
    const list = Array.from(remoteTasks.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((entry) => {
        // Merge entry's tracked agent tools with live realtime session state
        const agentTools: Record<string, string[]> = { ...entry.agentTools };
        const activeAgents: string[] = [];
        const doneAgents: string[] = Array.from(entry.doneAgents);
        const rtSession = getRealtimeSession(entry.sessionId);
        if (rtSession) {
          for (const [id, handle] of rtSession.agents.entries()) {
            if (handle.agentDef.role === "human") continue;
            const label = handle.agentDef.name || id;
            if (!agentTools[label]) agentTools[label] = [];
            if (handle.status === "working") activeAgents.push(label);
            else if (handle.status === "completed" && !doneAgents.includes(label)) doneAgents.push(label);
          }
        }
        return {
          taskId: entry.taskId,
          sessionId: entry.sessionId,
          status: entry.status,
          progress: entry.progress.slice(-20),
          result: entry.result,
          error: entry.error,
          startedAt: entry.startedAt,
          updatedAt: entry.updatedAt,
          elapsed: Math.round((Date.now() - entry.startedAt) / 1000),
          agentTools,
          activeAgents,
          doneAgents,
        };
      });
    return { tasks: list };
  });

  // Kill a running remote task
  fastify.post("/task/:id/kill", async (request, reply) => {
    const taskId = (request.params as any).id;
    const entry = remoteTasks.get(taskId);
    if (!entry) {
      reply.code(404);
      return { error: "Task not found" };
    }
    if (entry.status !== "running") {
      return { ok: true, status: entry.status, message: "Task already finished" };
    }
    entry.killed = true;
    entry.abortController?.abort();
    try {
      shutdownRealtimeSession(entry.sessionId);
    } catch {
      // session may not exist (simple chat mode) — ignore
    }
    entry.status = "error";
    entry.error = "Killed by user";
    addProgress(entry, "Killed by user");
    return { ok: true, status: "error" };
  });

  // Poll for task progress/result
  fastify.get("/task/:id", async (request, reply) => {
    const taskId = (request.params as any).id;
    const entry = remoteTasks.get(taskId);
    if (!entry) {
      reply.code(404);
      return { error: "Task not found" };
    }

    return {
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      status: entry.status,
      progress: entry.progress,
      progressSeq: entry.progressSeq,
      updatedAt: entry.updatedAt,
      result: entry.result,
      error: entry.error,
      elapsed: Math.round((Date.now() - entry.startedAt) / 1000),
    };
  });
}

// --- Async task processor ---

async function processRemoteTask(
  entry: RemoteTaskEntry,
  task: string,
  configFile: string,
  settings: any,
): Promise<void> {
  const { sessionId } = entry;

  // ─── Simple chat mode (with tools) ───
  if (!configFile) {
    addProgress(entry, "Processing with tools...");

    // Heartbeat so the caller knows we're still alive during long LLM calls
    const heartbeat = setInterval(() => {
      if (entry.status !== "running") { clearInterval(heartbeat); return; }
      addProgress(entry, "Still processing...");
    }, 10_000);

    try {
      const baseSystemPrompt = await buildSystemPrompt();
      const remoteInstruction = (settings.remoteSystemPrompt || "").trim();
      const systemPrompt = remoteInstruction
        ? `${remoteInstruction}\n\n${baseSystemPrompt}`
        : baseSystemPrompt;
      const result = await callTigerBotWithTools(
        [{ role: "user", content: task }],
        systemPrompt,
        (name, args) => {
          // Track tool for diagram view
          if (!entry.agentTools["Orchestrator"]) entry.agentTools["Orchestrator"] = [];
          entry.agentTools["Orchestrator"].push(name);
          entry.activeAgents.add("Orchestrator");
          // Send concise tool call info: tool name + short hint of what it's doing
          let hint = "";
          if (name === "web_search" && args?.query) hint = `: "${args.query.slice(0, 80)}"`;
          else if (name === "fetch_url" && args?.url) hint = `: ${args.url.slice(0, 80)}`;
          else if (name === "run_python" && args?.code) hint = ` (${args.code.length} chars)`;
          else if (name === "run_react" && args?.title) hint = `: ${args.title.slice(0, 60)}`;
          else if ((name === "read_file" || name === "write_file") && args?.path) hint = `: ${args.path.slice(0, 80)}`;
          else if (name === "list_files" && args?.path) hint = `: ${args.path.slice(0, 80)}`;
          else if (name === "send_task" && args?.to) hint = ` → ${args.to}`;
          addProgress(entry, `Tool: ${name}${hint}`);
          // Mirror to chat log
          const argsStr = args ? `\n${JSON.stringify(args, null, 2).slice(0, 600)}` : "";
          appendChatLog(sessionId, `\n[${chatLogTimestamp()}] TOOL_CALL: ${name}${argsStr}\n`);
        },
        (name, res) => {
          // Send concise result status: success/fail + short info
          const ok = res?.ok !== false && res?.exitCode !== 1;
          if (!ok) {
            const err = res?.error || res?.stderr || "failed";
            addProgress(entry, `✗ ${name}: ${String(err).slice(0, 120)}`);
          }
          appendChatLog(sessionId, `[${chatLogTimestamp()}] TOOL_RESULT: ${name}${ok ? "" : " (failed)"}\n`);
        },
        entry.abortController?.signal,
        undefined, // toolsOverride
        undefined, // modelOverride
        sessionId, // for checkpoint & resume
        undefined, // onRetry
        undefined, // taskId
        // onAgentText — capture single-agent reasoning/thinking to chat log
        (text: string) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          appendChatLog(sessionId, `\n[${chatLogTimestamp()}] AGENT THINKING:\n${trimmed}\n`);
        },
      );
      clearInterval(heartbeat);
      if (entry.killed) return;
      entry.result = result.content;
      entry.status = "completed";
      addProgress(entry, "Completed");

      // Save to chat history
      const sessions = await getChatHistory();
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        session.messages.push({ role: "assistant", content: result.content, timestamp: new Date().toISOString() });
        session.updatedAt = new Date().toISOString();
        await saveChatHistory(sessions);
      }
    } catch (err: any) {
      clearInterval(heartbeat);
      if (entry.killed) return;
      entry.status = "error";
      entry.error = err.message;
      addProgress(entry, `Error: ${err.message}`);
    }
    return;
  }

  // ─── Realtime agent mode ───
  // Hidden remote instructions — prepended to the task as system guidance the
  // caller never sees. Agents receive this as part of their incoming task.
  const remoteInstruction = (settings.remoteSystemPrompt || "").trim();
  const effectiveTask = remoteInstruction
    ? `[Remote instance instructions — follow these when answering]\n${remoteInstruction}\n\n[Incoming task]\n${task}`
    : task;

  addProgress(entry, `Starting realtime agents (${configFile})...`);

  const agentConfig = loadAgentConfig(configFile);
  if (!agentConfig) {
    entry.status = "error";
    entry.error = `Failed to load agent config: ${configFile}`;
    addProgress(entry, entry.error);
    return;
  }

  // Start the realtime session
  const rtSession = await startRealtimeSession(sessionId, configFile);
  if (!rtSession) {
    entry.status = "error";
    entry.error = "Failed to start realtime session";
    addProgress(entry, entry.error);
    return;
  }

  addProgress(entry, `Agents booted: ${Array.from(rtSession.agents.keys()).join(", ")}`);

  // Wait a moment for agents to initialize
  await new Promise((r) => setTimeout(r, 2000));

  // Find orchestrator or first connected agent
  const orchestratorDef = agentConfig.agents?.find((a: any) => a.role === "orchestrator");
  const humanDef = agentConfig.agents?.find((a: any) => a.role === "human");

  // Dispatches the task to the selected agent and returns the topic to wait
  // on. Returns null if no agent is available (terminal error). Called once
  // per retry attempt so each attempt runs against a freshly-started session.
  const dispatchTask = async (): Promise<{ waitTopic: string } | null> => {
    if (orchestratorDef) {
      const targetAgentId = orchestratorDef.id;
      addProgress(entry, `Sending task to orchestrator: ${orchestratorDef.name}`);
      busPublish(sessionId, humanDef?.id || "human", `task:${targetAgentId}`, {
        task: effectiveTask,
        context: "",
        from: humanDef?.id || "human",
      });
      return { waitTopic: `result:${targetAgentId}` };
    }
    const connected = getHumanConnectedAgents(sessionId);
    if (connected.length === 0) {
      const firstAgent = agentConfig.agents?.find((a: any) => a.role !== "human");
      if (!firstAgent) return null;
      const targetAgentId = firstAgent.id;
      addProgress(entry, `Sending task to agent: ${firstAgent.name}`);
      busPublish(sessionId, humanDef?.id || "human", `task:${targetAgentId}`, {
        task: effectiveTask,
        context: "",
        from: humanDef?.id || "human",
      });
      return { waitTopic: `result:${targetAgentId}` };
    }
    addProgress(entry, `Broadcasting task to ${connected.length} agents: ${connected.join(", ")}`);
    await humanBroadcastToAgents(sessionId, effectiveTask);
    return { waitTopic: `result:${connected[0]}` };
  };

  const firstDispatch = await dispatchTask();
  if (!firstDispatch) {
    entry.status = "error";
    entry.error = "No agents available to handle task";
    addProgress(entry, entry.error);
    shutdownRealtimeSession(sessionId);
    return;
  }
  let waitTopic = firstDispatch.waitTopic;

  // Start a progress monitor that periodically reports working agents
  // and syncs agent state for diagram/graphic views
  const progressInterval = setInterval(() => {
    if (entry.status !== "running") {
      clearInterval(progressInterval);
      return;
    }
    // Sync agent status from realtime session
    const rtSess = getRealtimeSession(sessionId);
    if (rtSess) {
      for (const [id, handle] of rtSess.agents.entries()) {
        if (handle.agentDef.role === "human") continue;
        const label = handle.agentDef.name || id;
        if (!entry.agentTools[label]) entry.agentTools[label] = [];
        if (handle.status === "working") {
          entry.activeAgents.add(label);
          entry.doneAgents.delete(label);
        } else if (handle.status === "completed" || handle.status === "error") {
          entry.activeAgents.delete(label);
          entry.doneAgents.add(label);
        }
      }
    }
    const working = getWorkingAgents(sessionId);
    if (working.length > 0) {
      const names = working.map((w) => w.agentName).join(", ");
      addProgress(entry, `Working: ${names}`);
    } else {
      addProgress(entry, "Agents processing...");
    }
  }, 5_000);

  // Wait for result — retry on timeout by cancelling the stale session,
  // resetting state, and re-delegating. Cap at `remoteTaskMaxRetries` (default
  // 2), so up to 3 total attempts before giving up. Non-timeout errors and
  // kills bail out immediately.
  const timeout = (settings.subAgentTimeout || 300) * 1000;
  const maxRetries = settings.remoteTaskMaxRetries ?? 2;
  const abortController = entry.abortController || new AbortController();

  const isTimeoutErr = (e: any) =>
    typeof e?.message === "string" && e.message.includes("busWaitForMessage timeout");

  let finalResult: string | null = null;
  let finalError: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resultMsg = await busWaitForMessage(sessionId, waitTopic, timeout, abortController.signal);
      finalResult = resultMsg.payload?.result || "(no result)";
      break;
    } catch (err: any) {
      if (entry.killed || abortController.signal.aborted) {
        finalError = null; // killed — handled below
        break;
      }
      if (!isTimeoutErr(err) || attempt === maxRetries) {
        finalError = isTimeoutErr(err)
          ? `Agent timed out after ${maxRetries + 1} attempts (${timeout / 1000}s each)`
          : `Agent error: ${err.message}`;
        break;
      }
      // Timeout with retries remaining: reset session and re-dispatch.
      addProgress(
        entry,
        `Agent timed out after ${timeout / 1000}s — re-delegating (attempt ${attempt + 2}/${maxRetries + 1})`,
      );
      try { shutdownRealtimeSession(sessionId); } catch {}
      entry.activeAgents.clear();
      entry.doneAgents.clear();
      const rt = await startRealtimeSession(sessionId, configFile);
      if (!rt) {
        finalError = "Failed to restart realtime session for retry";
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      const redispatch = await dispatchTask();
      if (!redispatch) {
        finalError = "No agents available on retry";
        break;
      }
      waitTopic = redispatch.waitTopic;
    }
  }

  clearInterval(progressInterval);
  try {
    if (entry.killed) return;
    if (finalResult !== null) {
      entry.result = finalResult;
      entry.status = "completed";
      addProgress(entry, "Completed (realtime agents)");

      const sessions = await getChatHistory();
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        session.messages.push({ role: "assistant", content: finalResult, timestamp: new Date().toISOString() });
        session.updatedAt = new Date().toISOString();
        await saveChatHistory(sessions);
      }
    } else {
      entry.status = "error";
      entry.error = finalError || "Unknown error";
      addProgress(entry, entry.error);
    }
  } finally {
    try { shutdownRealtimeSession(sessionId); } catch {}
  }
}
