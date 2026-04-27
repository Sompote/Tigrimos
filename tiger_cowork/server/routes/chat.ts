import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { getChatHistory, saveChatHistory, ChatSession, deleteAgentHistory } from "../services/data";
import { callTigerBot } from "../services/tigerbot";
import { getAutoCreatedArchitecture } from "../services/toolbox";
import yaml from "js-yaml";
import path from "path";
import fs from "fs";

const ACTIVITY_LOG_DIR = path.resolve("data", "activity_logs");
const CHAT_LOG_DIR = path.resolve("data", "chat_logs");

export async function chatRoutes(fastify: FastifyInstance) {
  // Get activity log for a session
  fastify.get("/sessions/:id/activity", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const logPath = path.join(ACTIVITY_LOG_DIR, `${sessionId}.log`);
    try {
      const content = fs.readFileSync(logPath, "utf-8");
      return { ok: true, content };
    } catch {
      return { ok: true, content: "" };
    }
  });

  // Get chat log for a session
  fastify.get("/sessions/:id/chatlog", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const logPath = path.join(CHAT_LOG_DIR, `${sessionId}.log`);
    try {
      const content = fs.readFileSync(logPath, "utf-8");
      return { ok: true, content };
    } catch {
      return { ok: true, content: "" };
    }
  });

  // Get all chat sessions
  fastify.get("/sessions", async (request, reply) => {
    const sessions = await getChatHistory();
    return sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  });

  // Get single session
  fastify.get("/sessions/:id", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) { reply.code(404); return { error: "Session not found" }; }

    // Include auto-created architecture info if present
    const autoArchFilename = getAutoCreatedArchitecture(sessionId);
    if (autoArchFilename) {
      try {
        const filePath = path.join(path.resolve("data/agents"), autoArchFilename);
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = yaml.load(content) as any;
        (session as any).autoCreatedArch = {
          filename: autoArchFilename,
          systemName: parsed?.system?.name || autoArchFilename.replace(/\.ya?ml$/, ""),
        };
      } catch {
        (session as any).autoCreatedArch = {
          filename: autoArchFilename,
          systemName: autoArchFilename.replace(/\.ya?ml$/, ""),
        };
      }
    }

    return session;
  });

  // Create new session
  fastify.post("/sessions", async (request, reply) => {
    const sessions = await getChatHistory();
    const body = request.body as any;
    const session: ChatSession = {
      id: uuid(),
      title: body.title || "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sessions.push(session);
    await saveChatHistory(sessions);
    return session;
  });

  // Delete session
  fastify.delete("/sessions/:id", async (request, reply) => {
    const sessionId = (request.params as any).id;
    let sessions = await getChatHistory();
    sessions = sessions.filter((s) => s.id !== sessionId);
    await saveChatHistory(sessions);
    // Clean up agent history folder for this session
    await deleteAgentHistory(sessionId);
    return { success: true };
  });

  // Rename session
  fastify.patch("/sessions/:id", async (request, reply) => {
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === (request.params as any).id);
    if (!session) { reply.code(404); return { error: "Session not found" }; }
    const body = request.body as any;
    if (body.title) session.title = body.title;
    await saveChatHistory(sessions);
    return session;
  });

  // Save thumb up/down + optional comment on a single message (by index)
  fastify.post("/sessions/:id/messages/:index/feedback", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const index = parseInt((request.params as any).index, 10);
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) { reply.code(404); return { ok: false, error: "Session not found" }; }
    if (!Number.isFinite(index) || index < 0 || index >= session.messages.length) {
      reply.code(400); return { ok: false, error: "Invalid message index" };
    }
    const body = (request.body as any) || {};
    const rating = body.rating === "up" || body.rating === "down" ? body.rating : undefined;
    const comment = typeof body.comment === "string" ? body.comment.slice(0, 4000) : undefined;
    if (rating === undefined && comment === undefined && body.clear !== true) {
      reply.code(400); return { ok: false, error: "Provide rating, comment, or clear=true" };
    }
    const msg: any = session.messages[index];
    if (body.clear === true) {
      delete msg.feedback;
    } else {
      const existing = msg.feedback || {};
      msg.feedback = {
        ...existing,
        ...(rating !== undefined ? { rating } : {}),
        ...(comment !== undefined ? { comment } : {}),
        submittedAt: new Date().toISOString(),
      };
    }
    session.updatedAt = new Date().toISOString();
    await saveChatHistory(sessions);
    return { ok: true, feedback: msg.feedback || null };
  });

  // Send message (non-streaming fallback)
  fastify.post("/sessions/:id/messages", async (request, reply) => {
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === (request.params as any).id);
    if (!session) { reply.code(404); return { error: "Session not found" }; }

    const body = request.body as any;
    session.messages.push({
      role: "user",
      content: body.message,
      timestamp: new Date().toISOString(),
    });

    const chatMessages = session.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const result = await callTigerBot(chatMessages);
    session.messages.push({
      role: "assistant",
      content: result.content,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    await saveChatHistory(sessions);

    return { content: result.content, usage: result.usage };
  });
}
