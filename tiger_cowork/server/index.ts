import Fastify from "fastify";
import { createServer } from "http";
import { Server } from "socket.io";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import middie from "@fastify/middie";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { chatRoutes } from "./routes/chat";
import { filesRoutes } from "./routes/files";
import { tasksRoutes } from "./routes/tasks";
import { skillsRoutes } from "./routes/skills";
import { settingsRoutes } from "./routes/settings";
import { pythonRoutes } from "./routes/python";
import { toolsRoutes } from "./routes/tools";
import { clawhubRoutes } from "./routes/clawhub";
import { projectsRoutes } from "./routes/projects";
import { agentsRoutes } from "./routes/agents";
import { setupSocket } from "./services/socket";
import { initMcpServers } from "./services/mcp";
import { initScheduler } from "./services/scheduler";
import { getFileTokens, saveFileTokens, generateToken, isValidFileToken } from "./services/data";

dotenv.config();

const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const PORT = Number(process.env.PORT) || 3001;
const SANDBOX_DIR = process.env.SANDBOX_DIR || path.resolve(".");
const DATA_DIR = path.resolve("data");

// Create raw HTTP server for sharing with Socket.io and Vite HMR
const httpServer = createServer();

const fastify = Fastify({
  logger: true,
  bodyLimit: 50 * 1024 * 1024, // 50MB
  serverFactory: (handler) => {
    httpServer.on("request", handler);
    return httpServer;
  },
});

// Socket.io on the shared HTTP server
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB — match Fastify bodyLimit
});

// Decorate fastify with shared config
fastify.decorate("sandboxDir", SANDBOX_DIR);
fastify.decorate("dataDir", DATA_DIR);

// Augment Fastify types
declare module "fastify" {
  interface FastifyInstance {
    sandboxDir: string;
    dataDir: string;
  }
}

async function start() {
  // Ensure directories exist
  const dirs = [SANDBOX_DIR, DATA_DIR, path.resolve("skills"), path.join(SANDBOX_DIR, "output_file"), path.join(DATA_DIR, "agents")];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));

  // Initialize data files
  const dataFiles = ["chat_history.json", "tasks.json", "settings.json", "skills.json", "projects.json", "file_tokens.json"];
  await Promise.all(
    dataFiles.map(async (file) => {
      const fp = path.join(DATA_DIR, file);
      try {
        await fs.access(fp);
      } catch {
        const initial =
          file === "settings.json"
            ? JSON.stringify({ sandboxDir: SANDBOX_DIR, tigerBotApiKey: "", tigerBotModel: "TigerBot-70B-Chat", mcpTools: [], webSearchEnabled: false }, null, 2)
            : "[]";
        await fs.writeFile(fp, initial);
      }
    })
  );

  // Auto-generate a default file access token if none exist
  const tokens = await getFileTokens();
  if (tokens.length === 0) {
    const defaultToken = {
      id: Date.now().toString(36),
      name: "Default",
      token: generateToken(),
      createdAt: new Date().toISOString(),
    };
    await saveFileTokens([defaultToken]);
    console.log(`[Security] Auto-generated file access token: ${defaultToken.token}`);
  }

  // Register plugins
  await fastify.register(fastifyCors, { origin: "*", methods: ["GET", "POST"] });

  // Auth verify endpoint (no auth required) — registered before auth hook
  fastify.post("/api/auth/verify", async (request, reply) => {
    if (!ACCESS_TOKEN) {
      return { ok: true, required: false };
    }
    const token = (request.body as any).token;
    if (token === ACCESS_TOKEN) {
      return { ok: true };
    }
    reply.code(401);
    return { ok: false, error: "Invalid access token" };
  });

  // API routes with auth hook
  await fastify.register(
    async function apiRoutes(api) {
      // Auth hook for all /api routes
      api.addHook("onRequest", async (request, reply) => {
        // Skip auth verify endpoint
        if (request.url.startsWith("/api/auth/verify")) return;
        if (!ACCESS_TOKEN) return;
        const token = request.headers.authorization?.replace("Bearer ", "") || (request.query as any).token;
        if (token === ACCESS_TOKEN) return;
        // Allow file token for /files routes
        if (request.url.startsWith("/api/files") && token && (await isValidFileToken(token))) return;
        reply.code(401);
        throw new Error("Unauthorized — invalid or missing access token");
      });

      // Register route plugins
      api.register(chatRoutes, { prefix: "/chat" });
      api.register(filesRoutes, { prefix: "/files" });
      api.register(tasksRoutes, { prefix: "/tasks" });
      api.register(skillsRoutes, { prefix: "/skills" });
      api.register(settingsRoutes, { prefix: "/settings" });
      api.register(pythonRoutes, { prefix: "/python" });
      api.register(toolsRoutes, { prefix: "/tools" });
      api.register(clawhubRoutes, { prefix: "/clawhub" });
      api.register(projectsRoutes, { prefix: "/projects" });
      api.register(agentsRoutes, { prefix: "/agents" });
    },
    { prefix: "/api" }
  );

  // Sandbox static files — protected by token
  fastify.register(
    async function sandboxRoutes(sandbox) {
      sandbox.addHook("onRequest", async (request, reply) => {
        if (!ACCESS_TOKEN) return;
        const fileToken = ((request.query as any).token as string) || request.headers.authorization?.replace("Bearer ", "");
        if (fileToken && (await isValidFileToken(fileToken))) return;
        if (fileToken === ACCESS_TOKEN) return;
        reply.code(401);
        throw new Error("Unauthorized — invalid or missing file access token");
      });

      sandbox.register(fastifyStatic, {
        root: SANDBOX_DIR,
        prefix: "/",
      });

      // Convert ENOENT errors to clean 404 responses
      sandbox.setErrorHandler(async (error, request, reply) => {
        if ((error as any).code === "ENOENT") {
          reply.code(404);
          return { error: "File not found" };
        }
        reply.code(500);
        return { error: (error as Error).message };
      });
    },
    { prefix: "/sandbox" }
  );

  // Socket.io access token auth
  if (ACCESS_TOKEN) {
    io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (token === ACCESS_TOKEN) return next();
      return next(new Error("Unauthorized — invalid or missing access token"));
    });
  }

  setupSocket(io);

  // Initialize scheduler
  await initScheduler();

  // Vite dev middleware or production static files
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      root: path.resolve("client"),
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    });
    await fastify.register(middie);
    fastify.use(vite.middlewares);
  } else {
    const clientDist = path.resolve("client/dist");
    if (fsSync.existsSync(clientDist)) {
      await fastify.register(fastifyStatic, {
        root: clientDist,
        prefix: "/",
        decorateReply: false, // avoid conflict with sandbox static
      });
      // SPA fallback
      fastify.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/") || request.url.startsWith("/sandbox/")) {
          reply.code(404);
          return { error: "Not found" };
        }
        return reply.sendFile("index.html");
      });
    }
  }

  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Tiger Cowork running on http://localhost:${PORT}`);
  console.log(`Sandbox directory: ${SANDBOX_DIR}`);

  // Initialize MCP servers in background (don't block startup)
  initMcpServers().catch((err) => console.error("[MCP] Init error:", err.message));
}

start();

export { io };
