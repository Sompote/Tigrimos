import { FastifyInstance } from "fastify";
import { getProjects, saveProjects, getSettings, getChatHistory, Project } from "../services/data";
import { callTigerBot } from "../services/tigerbot";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import multipart from "@fastify/multipart";
import { createReadStream } from "fs";

// Helper to resolve project working folder (handles relative paths)
async function resolveWorkingFolder(project: Project): Promise<string> {
  if (!project.workingFolder) return "";
  if (path.isAbsolute(project.workingFolder)) return project.workingFolder;
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  return path.join(sandboxDir, project.workingFolder);
}

// Helper to get sandbox-relative path for a file in a project
async function projectFileRelPath(resolvedFolder: string, subFilePath: string): Promise<string> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const fullPath = path.join(resolvedFolder, subFilePath);
  return path.relative(sandboxDir, fullPath);
}

export async function projectsRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // List all projects
  fastify.get("/", async (request, reply) => {
    return await getProjects();
  });

  // Get single project
  fastify.get("/:id", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    return project;
  });

  // Create project
  fastify.post("/", async (request, reply) => {
    const { name, description, workingFolder, skills } = request.body as any;
    const projects = await getProjects();
    const settings = await getSettings();

    // Resolve working folder path relative to sandbox
    let resolvedFolder = workingFolder || "";
    if (resolvedFolder && !path.isAbsolute(resolvedFolder)) {
      const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
      resolvedFolder = path.join(sandboxDir, resolvedFolder);
    }

    const project: Project = {
      id: uuid(),
      name: name || "Untitled Project",
      description: description || "",
      workingFolder: resolvedFolder,
      memory: "",
      skills: skills || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    projects.push(project);
    await saveProjects(projects);

    // Create working folder if specified and doesn't exist
    if (project.workingFolder && !fs.existsSync(project.workingFolder)) {
      fs.mkdirSync(project.workingFolder, { recursive: true });
    }

    return project;
  });

  // Update project
  fastify.patch("/:id", async (request, reply) => {
    const projects = await getProjects();
    const idx = projects.findIndex((p) => p.id === (request.params as any).id);
    if (idx === -1) { reply.code(404); return { error: "Project not found" }; }

    const updates = request.body as any;
    // Remove legacy fields if present
    delete updates.folderLocation;
    delete updates.folderAccess;
    projects[idx] = { ...projects[idx], ...updates, updatedAt: new Date().toISOString() };
    await saveProjects(projects);
    return projects[idx];
  });

  // Delete project
  fastify.delete("/:id", async (request, reply) => {
    let projects = await getProjects();
    projects = projects.filter((p) => p.id !== (request.params as any).id);
    await saveProjects(projects);
    return { ok: true };
  });

  // Get project memory -- read from {workingFolder}/memory.md
  fastify.get("/:id/memory", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }

    let content = "";
    if (project.workingFolder) {
      const memoryPath = path.join(project.workingFolder, "memory.md");
      try {
        if (fs.existsSync(memoryPath)) {
          content = fs.readFileSync(memoryPath, "utf-8");
        }
      } catch (err: any) {
        console.error(`Failed to read memory.md for project ${project.id}:`, err.message);
      }
    }
    // Fallback to stored memory if no file found
    if (!content && project.memory) {
      content = project.memory;
    }
    return { content };
  });

  // Save project memory -- write to {workingFolder}/memory.md
  fastify.put("/:id/memory", async (request, reply) => {
    const projects = await getProjects();
    const idx = projects.findIndex((p) => p.id === (request.params as any).id);
    if (idx === -1) { reply.code(404); return { error: "Project not found" }; }

    const content = (request.body as any).content || "";
    const project = projects[idx];

    // Write to memory.md in the working folder
    if (project.workingFolder) {
      const memoryPath = path.join(project.workingFolder, "memory.md");
      try {
        if (!fs.existsSync(project.workingFolder)) {
          fs.mkdirSync(project.workingFolder, { recursive: true });
        }
        fs.writeFileSync(memoryPath, content, "utf-8");
      } catch (err: any) {
        console.error(`Failed to write memory.md for project ${project.id}:`, err.message);
        reply.code(500); return { error: `Failed to write memory.md: ${err.message}` };
      }
    }

    // Also keep in project JSON as backup
    projects[idx].memory = content;
    projects[idx].updatedAt = new Date().toISOString();
    await saveProjects(projects);
    return { ok: true };
  });

  // Generate memory from chat history using LLM
  fastify.post("/:id/memory/generate", async (request, reply) => {
    try {
      const projects = await getProjects();
      const project = projects.find((p) => p.id === (request.params as any).id);
      if (!project) { reply.code(404); return { error: "Project not found" }; }

      // Find project chat sessions (prefixed with [ProjectName])
      const sessions = await getChatHistory();
      const prefix = `[${project.name}]`;
      const projectSessions = sessions.filter((s) => s.title.startsWith(prefix));

      if (projectSessions.length === 0) {
        reply.code(400); return { error: "No chat history found for this project" };
      }

      // Collect messages from all project sessions (limit to keep token usage reasonable)
      let chatSummary = "";
      for (const session of projectSessions.slice(-10)) {
        chatSummary += `\n--- Session: ${session.title} (${session.updatedAt}) ---\n`;
        for (const msg of session.messages.slice(-50)) {
          const role = msg.role === "user" ? "User" : "Assistant";
          const msgContent = typeof msg.content === "string" ? msg.content : "[non-text content]";
          chatSummary += `${role}: ${msgContent.slice(0, 500)}\n`;
        }
      }

      // Read existing memory if any
      let existingMemory = "";
      if (project.workingFolder) {
        const resolved = await resolveWorkingFolder(project);
        const memoryPath = path.join(resolved, "memory.md");
        try {
          if (fs.existsSync(memoryPath)) {
            existingMemory = fs.readFileSync(memoryPath, "utf-8");
          }
        } catch {}
      }
      if (!existingMemory && project.memory) existingMemory = project.memory;

      const prompt = `You are a project memory assistant. Analyze the chat history below from project "${project.name}" and generate a concise project memory document in Markdown format.

${existingMemory ? `Here is the existing project memory -- update and improve it based on the new chat history:\n\n${existingMemory}\n\n` : ""}Extract and organize the following information:
- **Project Overview**: What the project is about
- **Tech Stack**: Technologies, frameworks, libraries used
- **Key Decisions**: Important architectural or design decisions made
- **File Structure**: Important files and their purposes (if discussed)
- **Conventions**: Coding conventions or patterns established
- **Current Status**: What's been done and what's in progress
- **Notes**: Any other important information

Only include sections that have relevant information from the chat history. Be concise but thorough. Write in Markdown format.

--- CHAT HISTORY ---
${chatSummary.slice(0, 30000)}
--- END CHAT HISTORY ---

Generate the project memory document now:`;

      const result = await callTigerBot([
        { role: "user", content: prompt },
      ]);

      return { content: result.content };
    } catch (err: any) {
      console.error("Memory generation error:", err.message);
      reply.code(500); return { error: err.message || "Failed to generate memory" };
    }
  });

  // List files in project working folder
  fastify.get("/:id/files", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    if (!project.workingFolder) return { files: [] };

    const resolved = await resolveWorkingFolder(project);
    const subPath = (request.query as any).path || "";
    const fullPath = path.join(resolved, subPath);

    if (!fs.existsSync(fullPath)) return { files: [] };

    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const files = entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        size: e.isDirectory() ? 0 : fs.statSync(path.join(fullPath, e.name)).size,
        path: subPath ? `${subPath}/${e.name}` : e.name,
      }));
      return { files };
    } catch (err: any) {
      return { files: [], error: err.message };
    }
  });

  // Upload file to project working folder
  fastify.post("/:id/files/upload", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    if (!project.workingFolder) { reply.code(400); return { error: "No working folder" }; }

    const data = await request.file();
    if (!data) { reply.code(400); return { error: "No file" }; }

    const resolved = await resolveWorkingFolder(project);
    // Extract path field from multipart fields
    const pathField = data.fields?.path as any;
    const subPath = pathField?.value || "";
    const destDir = subPath ? path.join(resolved, subPath) : resolved;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const buffer = await data.toBuffer();
    const destPath = path.join(destDir, data.filename);
    fs.writeFileSync(destPath, buffer);
    return { success: true, name: data.filename };
  });

  // Create directory in project working folder
  fastify.post("/:id/files/mkdir", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    if (!project.workingFolder) { reply.code(400); return { error: "No working folder" }; }

    const body = request.body as any;
    const dirName = body.name;
    const subPath = body.path || "";
    if (!dirName) { reply.code(400); return { error: "name required" }; }

    const resolved = await resolveWorkingFolder(project);
    const fullPath = path.join(resolved, subPath, dirName);

    // Prevent path traversal
    if (!fullPath.startsWith(resolved)) { reply.code(403); return { error: "Invalid path" }; }

    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    return { success: true };
  });

  // Delete file/directory in project working folder
  fastify.delete("/:id/files", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    if (!project.workingFolder) { reply.code(400); return { error: "No working folder" }; }

    const filePath = (request.query as any).path as string;
    if (!filePath) { reply.code(400); return { error: "path required" }; }

    const resolved = await resolveWorkingFolder(project);
    const fullPath = path.join(resolved, filePath);

    // Prevent path traversal
    if (!fullPath.startsWith(resolved)) { reply.code(403); return { error: "Invalid path" }; }

    if (!fs.existsSync(fullPath)) { reply.code(404); return { error: "File not found" }; }

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      return { success: true };
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Download file from project working folder
  fastify.get("/:id/files/download", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    if (!project.workingFolder) { reply.code(400); return { error: "No working folder" }; }

    const filePath = (request.query as any).path as string;
    if (!filePath) { reply.code(400); return { error: "path required" }; }

    const resolved = await resolveWorkingFolder(project);
    const fullPath = path.join(resolved, filePath);

    if (!fullPath.startsWith(resolved)) { reply.code(403); return { error: "Invalid path" }; }
    if (!fs.existsSync(fullPath)) { reply.code(404); return { error: "File not found" }; }

    const fileName = path.basename(fullPath);
    reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
    return reply.send(createReadStream(fullPath));
  });

  // Get sandbox-relative path for a project file (for preview/display in output panel)
  fastify.get("/:id/files/sandbox-path", async (request, reply) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === (request.params as any).id);
    if (!project) { reply.code(404); return { error: "Project not found" }; }
    if (!project.workingFolder) { reply.code(400); return { error: "No working folder" }; }

    const filePath = (request.query as any).path as string;
    if (!filePath) { reply.code(400); return { error: "path required" }; }

    const resolved = await resolveWorkingFolder(project);
    const relPath = await projectFileRelPath(resolved, filePath);
    return { sandboxPath: relPath };
  });
}
