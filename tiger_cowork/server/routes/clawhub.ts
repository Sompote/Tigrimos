import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { clawhubSearch, clawhubInstall, clawhubInfo, listInstalledSkills, readSkill } from "../services/clawhub";
import { getSkills, saveSkills } from "../services/data";

export async function clawhubRoutes(fastify: FastifyInstance) {
  // List installed skills
  fastify.get("/skills", async (request, reply) => {
    try {
      return listInstalledSkills();
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Read a skill's SKILL.md
  fastify.get("/skills/:name", async (request, reply) => {
    const content = readSkill((request.params as any).name);
    if (!content) { reply.code(404); return { error: "Skill not found" }; }
    return { name: (request.params as any).name, content };
  });

  // Search clawhub catalog
  fastify.get("/search", async (request, reply) => {
    const query = String((request.query as any).q || "").trim();
    if (!query) { reply.code(400); return { error: "q parameter required" }; }
    const limit = Math.min(50, Math.max(1, Number((request.query as any).limit) || 10));
    try {
      const result = await clawhubSearch(query, limit);
      return result;
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Get skill detail/info from clawhub
  fastify.get("/info/:slug", async (request, reply) => {
    const slug = (request.params as any).slug;
    try {
      const result = await clawhubInfo(slug);
      return result;
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Install a skill from clawhub
  fastify.post("/install", async (request, reply) => {
    const { slug, force } = request.body as any;
    if (!slug) { reply.code(400); return { error: "slug required" }; }
    try {
      const result = await clawhubInstall(slug, Boolean(force));
      // Register in skills.json so it appears in the installed list
      if (result.installed) {
        const skills = await getSkills();
        const existing = skills.find((s) => s.name === slug && s.source === "clawhub");
        if (!existing) {
          // Read description from SKILL.md frontmatter
          let description = `ClawHub skill: ${slug}`;
          const skillFile = path.join(process.cwd(), "Tiger_bot", "skills", slug, "SKILL.md");
          if (fs.existsSync(skillFile)) {
            try {
              const content = fs.readFileSync(skillFile, "utf-8");
              const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
              if (fmMatch) {
                for (const line of fmMatch[1].split("\n")) {
                  const idx = line.indexOf(":");
                  if (idx > 0 && line.slice(0, idx).trim() === "description") {
                    description = line.slice(idx + 1).trim();
                    break;
                  }
                }
              }
            } catch {}
          }
          skills.push({
            id: uuid(),
            name: slug,
            description,
            source: "clawhub",
            script: slug,
            enabled: true,
            installedAt: new Date().toISOString(),
          });
          await saveSkills(skills);
        }
      }
      return result;
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });
}
