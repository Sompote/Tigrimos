import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import multipart from "@fastify/multipart";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import { getSkills, saveSkills } from "../services/data";
import { listInstalledSkills } from "../services/clawhub";

/** Parse SKILL.md frontmatter and return name + description */
function parseFrontmatter(content: string): { name: string; description: string } {
  let name = "";
  let description = "";
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === "name") name = val;
      else if (key === "description") description = val;
    }
  }
  return { name, description };
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
}
