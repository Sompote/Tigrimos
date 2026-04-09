import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { getChatHistory, saveChatHistory, ChatSession, deleteAgentHistory } from "../services/data";
import { callTigerBot } from "../services/tigerbot";
import fs from "fs";
import path from "path";

const ACTIVITY_LOG_DIR = path.resolve("data", "activity_logs");

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
  // Get all chat sessions
  fastify.get("/sessions", async (request, reply) => {
    const sessions = await getChatHistory();
    return sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  });

  // Get single session
  fastify.get("/sessions/:id", async (request, reply) => {
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === (request.params as any).id);
    if (!session) { reply.code(404); return { error: "Session not found" }; }
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
