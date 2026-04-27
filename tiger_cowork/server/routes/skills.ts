import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import multipart from "@fastify/multipart";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import yaml from "js-yaml";
import { getSkills, saveSkills, getSettings, getChatHistory, saveChatHistory } from "../services/data";
import { listInstalledSkills } from "../services/clawhub";
import { runSkillSynthesis, approveSkill, rejectSkill, getProposedDiff } from "../services/skill-synthesizer";

/** Parse SKILL.md frontmatter and return name + description */
function parseFrontmatter(content: string): { name: string; description: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return { name: "", description: "" };
  let parsed: any;
  try {
    parsed = yaml.load(fmMatch[1]);
  } catch {
    return { name: "", description: "" };
  }
  if (!parsed || typeof parsed !== "object") return { name: "", description: "" };
  const normalize = (v: any) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  return {
    name: normalize(parsed.name),
    description: normalize(parsed.description),
  };
}

export async function skillsRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  fastify.get("/", async (request, reply) => {
    const skills = await getSkills();
    // Merge in any ClawHub-installed skills not yet registered in skills.json
    try {
      const clawhubSkills = listInstalledSkills();
      let changed = false;
      for (const cs of clawhubSkills) {
        if (cs.installed && !skills.some((s) => s.name === cs.name && s.source === "clawhub")) {
          skills.push({
            id: uuid(),
            name: cs.name,
            description: cs.description || `ClawHub skill: ${cs.name}`,
            source: "clawhub" as const,
            script: cs.name,
            enabled: true,
            installedAt: new Date().toISOString(),
          });
          changed = true;
        }
      }
      if (changed) await saveSkills(skills);
    } catch {}
    return skills;
  });

  // Install skill
  fastify.post("/", async (request, reply) => {
    const skills = await getSkills();
    const body = request.body as any;
    const skill = {
      id: uuid(),
      name: body.name || "Untitled Skill",
      description: body.description || "",
      source: body.source || "custom",
      script: body.script || "",
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    skills.push(skill);
    await saveSkills(skills);
    return skill;
  });

  // Toggle or update skill
  fastify.patch("/:id", async (request, reply) => {
    const skills = await getSkills();
    const idx = skills.findIndex((s) => s.id === (request.params as any).id);
    if (idx < 0) { reply.code(404); return { error: "Not found" }; }
    Object.assign(skills[idx], request.body as any);
    await saveSkills(skills);
    return skills[idx];
  });

  // Uninstall
  fastify.delete("/:id", async (request, reply) => {
    let skills = await getSkills();
    skills = skills.filter((s) => s.id !== (request.params as any).id);
    await saveSkills(skills);
    return { success: true };
  });

  // Upload skill — accepts SKILL.md file or .zip folder
  fastify.post("/upload", async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) { reply.code(400); return { error: "No file uploaded" }; }

      const buffer = await data.toBuffer();
      const originalname = data.filename;
      const ext = path.extname(originalname).toLowerCase();
      let name = "";
      let description = "";

      if (ext === ".zip") {
        // --- ZIP upload: extract entire folder as a skill ---
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        // Find SKILL.md inside the zip (may be at root or inside a single top-level folder)
        let skillMdEntry = entries.find((e) => e.entryName === "SKILL.md" || e.entryName.endsWith("/SKILL.md"));
        // Determine the prefix (top-level folder inside zip, if any)
        let prefix = "";
        if (skillMdEntry && skillMdEntry.entryName.includes("/")) {
          prefix = skillMdEntry.entryName.replace(/SKILL\.md$/, "");
        }

        // Parse frontmatter from SKILL.md if found
        if (skillMdEntry) {
          const skillMdContent = skillMdEntry.getData().toString("utf-8");
          const parsed = parseFrontmatter(skillMdContent);
          name = parsed.name;
          description = parsed.description;
        }

        // Fallback name from zip filename
        if (!name) {
          name = path.basename(originalname, ".zip");
        }

        const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
        const skillDir = path.join(process.cwd(), "skills", sanitized);
        fs.mkdirSync(skillDir, { recursive: true });

        // Extract all entries under the prefix into skillDir
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          // Strip the prefix to flatten if zip has a single top-level folder
          let relativePath = entry.entryName;
          if (prefix && relativePath.startsWith(prefix)) {
            relativePath = relativePath.slice(prefix.length);
          }
          // Skip hidden/system files
          if (relativePath.startsWith("__MACOSX") || relativePath.startsWith(".")) continue;

          const destPath = path.join(skillDir, relativePath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, entry.getData());
        }

        // If no SKILL.md was in the zip, create a minimal one
        if (!skillMdEntry) {
          const minimalSkillMd = `---\nname: ${name}\ndescription: Custom skill\n---\n\n# ${name}\n`;
          fs.writeFileSync(path.join(skillDir, "SKILL.md"), minimalSkillMd, "utf-8");
        }

        // Count extracted files for response
        const fileCount = entries.filter((e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX")).length;

        // Register in skills.json
        const skills = await getSkills();
        const existing = skills.find((s) => s.name === name && s.source === "custom");
        if (existing) {
          existing.script = name;
          existing.description = description || existing.description;
          await saveSkills(skills);
          return { ...existing, fileCount };
        }

        const skill = {
          id: uuid(),
          name,
          description: description || `Custom skill from ${originalname}`,
          source: "custom" as const,
          script: name,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
        skills.push(skill);
        await saveSkills(skills);
        return { ...skill, fileCount };

      } else {
        // --- Single SKILL.md file upload (existing behavior) ---
        const content = buffer.toString("utf-8");
        const parsed = parseFrontmatter(content);
        name = parsed.name;
        description = parsed.description;

        if (!name) {
          name = path.basename(originalname, path.extname(originalname));
        }

        const skillDir = path.join(process.cwd(), "skills", name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase());
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");

        const skills = await getSkills();
        const existing = skills.find((s) => s.name === name && s.source === "custom");
        if (existing) {
          existing.script = name;
          existing.description = description || existing.description;
          await saveSkills(skills);
          return existing;
        }

        const skill = {
          id: uuid(),
          name,
          description: description || `Custom skill from ${originalname}`,
          source: "custom" as const,
          script: name,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
        skills.push(skill);
        await saveSkills(skills);
        return skill;
      }
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Browse available skills (Claude / OpenClaw catalog)
  fastify.get("/catalog", async (request, reply) => {
    // Built-in skill catalog
    const catalog = [
      { name: "Web Search", description: "Search the web using configured search engine", source: "claude", script: "web-search" },
      { name: "Code Review", description: "Review code for quality and security issues", source: "claude", script: "code-review" },
      { name: "File Converter", description: "Convert between file formats (PDF, DOCX, CSV)", source: "claude", script: "file-converter" },
      { name: "Data Analyzer", description: "Analyze CSV/JSON data and generate charts", source: "openclaw", script: "data-analyzer" },
      { name: "API Tester", description: "Test REST APIs with custom requests", source: "openclaw", script: "api-tester" },
      { name: "Markdown Renderer", description: "Render markdown to HTML/PDF", source: "openclaw", script: "markdown-renderer" },
      { name: "Git Helper", description: "Git operations within sandbox", source: "claude", script: "git-helper" },
      { name: "Image Processor", description: "Resize, crop, and convert images", source: "openclaw", script: "image-processor" },
    ];
    return catalog;
  });

  // ─── View / Download Skill Content ───

  // Helper to find a skill's SKILL.md file on disk
  function findSkillFile(skill: { name: string; script: string; source: string }): string | null {
    const slug = skill.script || skill.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    // Check custom/auto skills dir first
    const customPath = path.join(process.cwd(), "skills", slug, "SKILL.md");
    if (fs.existsSync(customPath)) return customPath;
    // Check ClawHub skills dir
    const clawhubPath = path.join(process.cwd(), "Tiger_bot", "skills", slug, "SKILL.md");
    if (fs.existsSync(clawhubPath)) return clawhubPath;
    // Try by name as slug
    const nameSlug = skill.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const customPath2 = path.join(process.cwd(), "skills", nameSlug, "SKILL.md");
    if (fs.existsSync(customPath2)) return customPath2;
    const clawhubPath2 = path.join(process.cwd(), "Tiger_bot", "skills", nameSlug, "SKILL.md");
    if (fs.existsSync(clawhubPath2)) return clawhubPath2;
    return null;
  }

  // Read skill content (SKILL.md)
  fastify.get("/:id/content", async (request, reply) => {
    const skills = await getSkills();
    const skill = skills.find((s) => s.id === (request.params as any).id);
    if (!skill) { reply.code(404); return { error: "Skill not found" }; }

    const filePath = findSkillFile(skill);
    if (!filePath) {
      // For custom skills with inline script, return the script as content
      if (skill.script && !skill.script.includes("/")) {
        return { ok: true, name: skill.name, content: skill.script, source: skill.source, hasFile: false };
      }
      return { ok: false, error: "SKILL.md file not found on disk" };
    }

    const content = fs.readFileSync(filePath, "utf-8");
    return { ok: true, name: skill.name, content, source: skill.source, hasFile: true, path: filePath };
  });

  // Download skill as SKILL.md file
  fastify.get("/:id/download", async (request, reply) => {
    const skills = await getSkills();
    const skill = skills.find((s) => s.id === (request.params as any).id);
    if (!skill) { reply.code(404); return { error: "Skill not found" }; }

    const filePath = findSkillFile(skill);
    if (!filePath) {
      // Inline script — generate a SKILL.md on the fly
      const slug = skill.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
      const content = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.script || ""}`;
      reply.header("Content-Type", "text/markdown");
      reply.header("Content-Disposition", `attachment; filename="${slug}.SKILL.md"`);
      return content;
    }

    const slug = skill.script || skill.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const content = fs.readFileSync(filePath, "utf-8");
    reply.header("Content-Type", "text/markdown");
    reply.header("Content-Disposition", `attachment; filename="${slug}.SKILL.md"`);
    return content;
  });

  // ─── Auto Skill Generation ───

  // Trigger synthesis immediately
  fastify.post("/auto/run-now", async (request, reply) => {
    try {
      const result = await runSkillSynthesis({ manual: true });
      return result;
    } catch (err: any) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  // Get auto-update status
  fastify.get("/auto/status", async (request, reply) => {
    const settings = await getSettings();
    return {
      enabled: settings.skillAutoUpdateEnabled ?? true,
      intervalMinutes: settings.skillAutoUpdateIntervalMinutes ?? 60,
      maxCandidates: settings.skillAutoUpdateMaxCandidates ?? 30,
      requireApproval: settings.skillAutoUpdateRequireApproval !== false,
      cursor: settings.skillAutoUpdateCursor || null,
      lastRunAt: settings.skillAutoUpdateLastRunAt || null,
      lastRunSummary: settings.skillAutoUpdateLastRunSummary || null,
    };
  });

  // Approve pending skill
  fastify.post("/:id/approve", async (request, reply) => {
    const result = await approveSkill((request.params as any).id);
    if (!result.ok) { reply.code(400); }
    return result;
  });

  // Reject pending skill
  fastify.post("/:id/reject", async (request, reply) => {
    const result = await rejectSkill((request.params as any).id);
    if (!result.ok) { reply.code(400); }
    return result;
  });

  // Get proposed diff
  fastify.get("/:id/proposed-diff", async (request, reply) => {
    const result = await getProposedDiff((request.params as any).id);
    if (!result.ok) { reply.code(404); }
    return result;
  });

  // ─── Chat Skill Feedback ───

  // Mark/unmark a chat session as skill candidate
  fastify.post("/feedback", async (request, reply) => {
    const body = request.body as any;
    const { sessionId, skillCandidate, skillFeedback } = body;
    if (!sessionId) { reply.code(400); return { error: "Missing sessionId" }; }

    const sessions = await getChatHistory();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) { reply.code(404); return { error: "Session not found" }; }

    if (skillCandidate !== undefined) (session as any).skillCandidate = skillCandidate;
    if (skillFeedback !== undefined) (session as any).skillFeedback = skillFeedback;
    session.updatedAt = new Date().toISOString();
    await saveChatHistory(sessions);

    return { ok: true, sessionId, skillCandidate: (session as any).skillCandidate, skillFeedback: (session as any).skillFeedback };
  });

  // Get feedback status for a session
  fastify.get("/feedback/:sessionId", async (request, reply) => {
    const sessionId = (request.params as any).sessionId;
    const sessions = await getChatHistory();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) { reply.code(404); return { error: "Session not found" }; }
    return {
      ok: true,
      sessionId,
      skillCandidate: (session as any).skillCandidate || false,
      skillFeedback: (session as any).skillFeedback || null,
    };
  });
}
