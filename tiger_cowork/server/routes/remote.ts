import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { getSettings, getChatHistory, saveChatHistory, ChatSession } from "../services/data";
import { callTigerBotWithTools, callTigerBot } from "../services/tigerbot";
import { startRealtimeSession, shutdownRealtimeSession, getToolsForRealtimeOrchestrator, collectPendingResults, setSubagentStatusCallback } from "../services/toolbox";

// ─── In-memory task store ───

interface RemoteTaskEntry {
  taskId: string;
  sessionId: string;
  status: "running" | "completed" | "error";
  progress: string[];
  result: string | null;
  error: string | null;
  startedAt: number;
}

const tasks = new Map<string, RemoteTaskEntry>();

function ts(): string {
  const d = new Date();
  return `[${d.toTimeString().split(" ")[0]}]`;
}

// Clean up completed tasks older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, t] of tasks) {
    if (t.status !== "running" && t.startedAt < cutoff) tasks.delete(id);
  }
}, 60_000);

export async function remoteRoutes(fastify: FastifyInstance) {
  // POST /api/remote/task — submit a task
  fastify.post("/task", async (request, reply) => {
    const { task } = request.body as any;
    if (!task) {
      reply.code(400);
      return { error: "task is required" };
    }

    const taskId = uuid();
    const sessionId = `remote-${taskId}`;

    const entry: RemoteTaskEntry = {
      taskId,
      sessionId,
      status: "running",
      progress: [],
      result: null,
      error: null,
      startedAt: Date.now(),
    };
    tasks.set(taskId, entry);

    // Run in background — don't await
    processTask(entry, task).catch((err) => {
      entry.status = "error";
      entry.error = `Unhandled: ${err.message}`;
      entry.progress.push(`${ts()} Error: ${err.message}`);
    });

    return { taskId, sessionId };
  });

  // GET /api/remote/task/:taskId — poll status
  fastify.get("/task/:taskId", async (request, reply) => {
    const { taskId } = request.params as any;
    const entry = tasks.get(taskId);
    if (!entry) {
      reply.code(404);
      return { error: "Task not found" };
    }
    return {
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      status: entry.status,
      progress: entry.progress,
      result: entry.result,
      error: entry.error,
      elapsed: Math.round((Date.now() - entry.startedAt) / 1000),
    };
  });
}

// ─── Background task processor ───

async function processTask(entry: RemoteTaskEntry, task: string): Promise<void> {
  const settings = await getSettings();
  const isRealtime = settings.subAgentEnabled && settings.subAgentMode === "realtime" && settings.subAgentConfigFile;

  // Create a chat session for history
  const sessions = await getChatHistory();
  const session: ChatSession = {
    id: entry.sessionId,
    title: `Remote: ${task.slice(0, 50)}`,
    messages: [{ role: "user", content: task, timestamp: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sessions.push(session);
  await saveChatHistory(sessions);

  const chatMessages = [{ role: "user" as const, content: task }];
  const abortController = new AbortController();

  // Heartbeat — emit progress every 10s so the caller's idle timeout doesn't fire
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
    entry.progress.push(`${ts()} Still working... (${elapsed}s)`);
  }, 10_000);

  try {
    if (isRealtime) {
      entry.progress.push(`${ts()} Starting realtime agents (${settings.subAgentConfigFile})...`);

      // Boot agents
      const rtSession = await startRealtimeSession(entry.sessionId, settings.subAgentConfigFile!, abortController.signal);

      const agentNames = Array.from(rtSession.agents.values()).map((a: any) => a.agentDef.name || a.agentDef.id);
      entry.progress.push(`${ts()} Agents booted: ${agentNames.join(", ")}`);

      // Set up status callback for progress tracking
      setSubagentStatusCallback((status: any) => {
        if (status.sessionId !== entry.sessionId) return;
        if (status.status === "running" && status.label) {
          const working = status.content ? `${status.label}: ${status.content.slice(0, 80)}` : `Working: ${status.label}`;
          entry.progress.push(`${ts()} ${working}`);
        } else if (status.status === "done" && status.label) {
          entry.progress.push(`${ts()} Done: ${status.label}`);
        }
      });

      // Get realtime tools and run
      const realtimeTools = await getToolsForRealtimeOrchestrator();
      const systemPrompt = buildRemoteSystemPrompt(settings, true);

      const result = await callTigerBotWithTools(
        chatMessages,
        systemPrompt,
        (name, args) => {
          if (name === "send_task") {
            entry.progress.push(`${ts()} Sending task to ${args.to || "agent"}: ${(args.task || "").slice(0, 80)}`);
          } else if (name === "wait_result") {
            entry.progress.push(`${ts()} Waiting for ${args.from || "agent"}`);
          } else {
            entry.progress.push(`${ts()} Tool: ${name}`);
          }
        },
        (name, toolResult) => {
          if (name === "wait_result" && toolResult?.result) {
            entry.progress.push(`${ts()} Result from ${toolResult.agentName || "agent"}: ${String(toolResult.result).slice(0, 80)}`);
          }
        },
        abortController.signal,
        realtimeTools,
        undefined, // modelOverride
        entry.sessionId, // sessionId for checkpoint
      );

      // Collect pending results
      let fullResult = result.content || "";
      const pending = collectPendingResults(entry.sessionId);
      if (pending.length > 0) {
        fullResult += "\n\n---\n**Agent Results:**\n";
        for (const pr of pending) {
          fullResult += `\n**${pr.agentName}:**\n${pr.result}\n`;
        }
      }

      entry.status = "completed";
      entry.result = fullResult;
      entry.progress.push(`${ts()} Completed (realtime agents)`);

      // Shutdown agents
      shutdownRealtimeSession(entry.sessionId);
    } else {
      // Chat mode with tools — full tool loop
      entry.progress.push(`${ts()} Processing with tools...`);
      const systemPrompt = buildRemoteSystemPrompt(settings, false);

      try {
        const result = await callTigerBotWithTools(
          chatMessages,
          systemPrompt,
          // onToolCall — log each tool invocation to progress
          (name, args) => {
            const argSummary = args.task ? args.task.slice(0, 60) : (args.code ? "python..." : (args.query || args.path || ""));
            entry.progress.push(`${ts()} Tool: ${name}${argSummary ? " — " + argSummary : ""}`);
          },
          // onToolResult — log completion
          (name, toolResult) => {
            const ok = toolResult?.ok !== false && !toolResult?.error;
            entry.progress.push(`${ts()} ${name} ${ok ? "done" : "failed"}`);
          },
          abortController.signal,
          undefined, // realtimeTools
          undefined, // modelOverride
          entry.sessionId, // sessionId for checkpoint
        );

        entry.status = "completed";
        entry.result = result.content || "";
        entry.progress.push(`${ts()} Completed (with tools)`);
      } catch (toolErr: any) {
        // Fallback to simple call without tools
        entry.progress.push(`${ts()} Tool mode failed (${toolErr.message?.slice(0, 60)}), falling back to simple chat...`);
        try {
          const result = await callTigerBot(chatMessages, systemPrompt);
          entry.status = "completed";
          entry.result = result.content || "";
          entry.progress.push(`${ts()} Completed (simple chat fallback)`);
        } catch (fallbackErr: any) {
          entry.status = "error";
          entry.error = `Both tool and simple chat failed: ${fallbackErr.message}`;
          entry.progress.push(`${ts()} Error: ${fallbackErr.message}`);
        }
      }
    }

    clearInterval(heartbeat);

    // Save assistant response to chat history
    const updatedSessions = await getChatHistory();
    const updatedSession = updatedSessions.find((s) => s.id === entry.sessionId);
    if (updatedSession) {
      updatedSession.messages.push({
        role: "assistant",
        content: entry.result || entry.error || "",
        timestamp: new Date().toISOString(),
      });
      updatedSession.updatedAt = new Date().toISOString();
      await saveChatHistory(updatedSessions);
    }
  } catch (err: any) {
    clearInterval(heartbeat);
    entry.status = "error";
    entry.error = `Agent timeout or error: ${err.message}`;
    entry.progress.push(`${ts()} Error: ${err.message}`);
  }
}

function buildRemoteSystemPrompt(settings: any, isRealtime: boolean): string {
  let delegationRules = "";
  if (isRealtime) {
    delegationRules = `
REALTIME AGENT MODE: All agents are already alive. Delegate ALL work to the agent team via send_task/wait_result.
- If an orchestrator exists, send tasks ONLY to the orchestrator — it manages all sub-delegation.
- Workflow: send_task → wait_result → synthesize response. Only use run_python/write_file for formatting final output.
- Always delegate, even for follow-ups or corrections. Include chat context so agents know what to fix.`;
  } else if (settings.subAgentEnabled) {
    delegationRules = `
SUB-AGENTS: Use spawn_subagent for complex multi-part tasks. Each sub-agent runs independently with full tool access.`;
  }

  return `You are TigrimOS, an AI assistant with tools for search, code execution, files, and skills.
This is a REMOTE TASK — you are processing a delegated task from another Tiger Cowork instance.
${delegationRules}

Rules:
- Always use tools to produce real results — never just describe what you would do.
- If a tool call fails, analyze the error, fix it, and retry. Try a different approach after two failures.
- Do not call the same tool with identical arguments repeatedly.

Output files:
- Python working directory is output_file/ in the sandbox.
- Save charts as .png (plt.savefig, never plt.show). Save reports as .html or .pdf.
- Generate actual output files — don't just print data.`;
}
