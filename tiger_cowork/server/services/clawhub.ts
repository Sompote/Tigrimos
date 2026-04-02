import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);
const TIGER_BOT_DIR = path.resolve("Tiger_bot");
const SKILLS_DIR = path.join(TIGER_BOT_DIR, "skills");

async function findClawhubBin(): Promise<string> {
  const local = path.join(TIGER_BOT_DIR, "node_modules", ".bin", "clawhub");
  for (const bin of [local, "clawhub"]) {
    try {
      await execFileAsync(bin, ["--cli-version"], { timeout: 5000 });
      return bin;
    } catch {}
  }
  throw new Error("clawhub CLI not found. Install with: npm i -g clawhub");
}

export async function clawhubSearch(query: string, limit = 10) {
  const bin = await findClawhubBin();
  const { stdout, stderr } = await execFileAsync(
    bin,
    ["search", query, "--limit", String(limit), "--no-input", "--workdir", TIGER_BOT_DIR, "--dir", "skills"],
    { timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  return { ok: true, output: stdout.trim(), warning: stderr.trim() };
}

export async function clawhubInstall(slug: string, force = false) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return { ok: false, error: "Invalid slug format" };
  }
  const skillPath = path.join(SKILLS_DIR, slug, "SKILL.md");
  const bin = await findClawhubBin();
  const argv = ["install", slug, "--no-input", "--workdir", TIGER_BOT_DIR, "--dir", "skills"];
  if (force) argv.push("--force");

  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      slug,
      installed: fs.existsSync(skillPath),
      output: stdout.trim(),
      warning: stderr.trim(),
    };
  } catch (err: any) {
    const msg = err.stderr || err.message || "";

    // Already installed on disk — treat as success
    if (msg.includes("Already installed") && fs.existsSync(skillPath)) {
      return { ok: true, slug, installed: true, output: "Skill already installed", warning: "" };
    }

    // Rate limit — retry once after a short delay
    if (msg.includes("Rate limit")) {
      try {
        await new Promise((r) => setTimeout(r, 3000));
        const { stdout, stderr } = await execFileAsync(bin, argv, {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        });
        return {
          ok: true,
          slug,
          installed: fs.existsSync(skillPath),
          output: stdout.trim(),
          warning: stderr.trim(),
        };
      } catch (retryErr: any) {
        // If still rate-limited but skill exists on disk, treat as success
        if (fs.existsSync(skillPath)) {
          return { ok: true, slug, installed: true, output: "Skill files found on disk", warning: "" };
        }
        return { ok: false, slug, installed: false, error: retryErr.stderr || retryErr.message || "Rate limit exceeded, please try again later" };
      }
    }

    // Other errors — still check if files exist on disk
    if (fs.existsSync(skillPath)) {
      return { ok: true, slug, installed: true, output: "Skill files found on disk", warning: msg };
    }

    return { ok: false, slug, installed: false, error: msg };
  }
}

export function listInstalledSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  // Read lock.json for version info
  const lockFile = path.join(TIGER_BOT_DIR, ".clawhub", "lock.json");
  let lockData: Record<string, { version?: string }> = {};
  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
      lockData = lock.skills || {};
    } catch {}
  }

  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const skillFile = path.join(SKILLS_DIR, d.name, "SKILL.md");
      let description = "";

      // Read description from SKILL.md frontmatter
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

      const version = lockData[d.name]?.version || "";
      return { name: d.name, installed: fs.existsSync(skillFile), description, version };
    });
}

export function readSkill(name: string): string | null {
  const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  return fs.readFileSync(skillFile, "utf-8");
}

export async function clawhubInfo(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return { ok: false, error: "Invalid slug format" };
  }

  // 1. If installed locally, read SKILL.md for full details
  const skillFile = path.join(SKILLS_DIR, slug, "SKILL.md");
  if (fs.existsSync(skillFile)) {
    const content = fs.readFileSync(skillFile, "utf-8");
    let meta: any = {};
    const metaFile = path.join(SKILLS_DIR, slug, "_meta.json");
    if (fs.existsSync(metaFile)) {
      try { meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")); } catch {}
    }
    return {
      ok: true,
      slug,
      installed: true,
      output: content,
      meta,
    };
  }

  // 2. Not installed — quick-install to a temp dir, read SKILL.md, then clean up
  const tmpDir = path.join(TIGER_BOT_DIR, "_preview_tmp");
  const tmpSkillsDir = path.join(tmpDir, "skills");
  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const bin = await findClawhubBin();
    await execFileAsync(
      bin,
      ["install", slug, "--no-input", "--workdir", tmpDir, "--dir", "skills"],
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );

    const tmpSkillFile = path.join(tmpSkillsDir, slug, "SKILL.md");
    const tmpMetaFile = path.join(tmpSkillsDir, slug, "_meta.json");
    let output = "";
    let meta: any = {};

    if (fs.existsSync(tmpSkillFile)) {
      output = fs.readFileSync(tmpSkillFile, "utf-8");
    }
    if (fs.existsSync(tmpMetaFile)) {
      try { meta = JSON.parse(fs.readFileSync(tmpMetaFile, "utf-8")); } catch {}
    }

    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    if (output) {
      return { ok: true, slug, installed: false, output, meta };
    }
  } catch (err: any) {
    // Clean up on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    // 3. Fallback: search for the exact slug
    try {
      const bin = await findClawhubBin();
      const { stdout } = await execFileAsync(
        bin,
        ["search", slug, "--limit", "5", "--no-input", "--workdir", TIGER_BOT_DIR, "--dir", "skills"],
        { timeout: 15000, maxBuffer: 1024 * 1024 }
      );
      const lines = stdout.trim().split("\n");
      const match = lines.find((l) => l.startsWith(slug + " ") || l.trim() === slug);
      if (match) {
        return { ok: true, slug, installed: false, output: match };
      }
    } catch {}
  }

  return {
    ok: true,
    slug,
    installed: false,
    output: `Could not load details for "${slug}". Try installing the skill to see its full documentation.`,
  };
}
