import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import yaml from "js-yaml";
import { v4 as uuid } from "uuid";
import {
  getSettings,
  saveSettings,
  getChatHistory,
  getSkills,
  saveSkills,
  Skill,
  ChatSession,
} from "./data";
import { callTigerBot } from "./tigerbot";

const SKILLS_DIR = path.resolve("skills");

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 1024;
const MAX_BODY_CHARS = 100_000;

let inflight = false;

// ─── Cron handle ───
let cronJob: cron.ScheduledTask | null = null;

/** Boot or reboot the skill-auto-update cron based on current settings */
export async function initSkillSynthesizer(): Promise<void> {
  const settings = await getSettings();
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (!settings.skillAutoUpdateEnabled) return;
  const mins = Math.max(5, Math.min(1440, settings.skillAutoUpdateIntervalMinutes || 60));
  const expr = `*/${mins} * * * *`;
  if (!cron.validate(expr)) return;
  cronJob = cron.schedule(expr, () => { runSkillSynthesis().catch(console.error); });
  console.log(`[SkillSynth] Cron started: every ${mins} min`);
}

/** Restart cron (call after settings change) */
export async function restartSkillSynthesizer(): Promise<void> {
  await initSkillSynthesizer();
}

// ─── Interfaces ───

interface Proposal {
  kind: "create" | "update";
  name: string;
  description: string;
  content: string;          // full SKILL.md including frontmatter
  basedOn: string[];        // session IDs
  rationale?: string;
}

export interface RunSummary {
  ok: boolean;
  created: number;
  updated: number;
  skipped: number;
  reasons: string[];
  error?: string;
  // compat fields used by frontend
  pending?: number;
  errors?: string[];
  summary?: string;
}

interface FeedbackEntry {
  role: string;
  rating?: "up" | "down";
  comment?: string;
  excerpt?: string;
}

interface SubagentTrace {
  label: string;
  task?: string;
  toolsUsed: string[];
  skillsLoaded: string[];
  completed: boolean;
  error?: string;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  userQueries: string[];
  finalAssistant: string;
  feedback: FeedbackEntry[];
  subagentWorkflow: SubagentTrace[];
}

// ─── Helpers ───

function isErrorReply(content: string): boolean {
  if (!content) return true;
  const head = content.slice(0, 200).toLowerCase();
  return (
    head.startsWith("connection error:") ||
    head.includes("api key not configured") ||
    head.includes("unauthorized") ||
    head.startsWith("tigerbot api key not configured") ||
    head.startsWith("no response from tigerbot") ||
    head.startsWith("context overflow") ||
    head.startsWith("api error (") ||
    head.startsWith("error:")
  );
}

function sanitizeSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

// ─── Chat log parsing for sub-agent workflows ───

const CHAT_LOG_DIR = path.resolve("data", "chat_logs");
const CHAT_LOG_TAIL_BYTES = 256 * 1024;

async function readChatLogTail(sessionId: string): Promise<string> {
  const file = path.join(CHAT_LOG_DIR, `${sessionId}.log`);
  try {
    const stat = await fs.stat(file);
    const start = Math.max(0, stat.size - CHAT_LOG_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return "";
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return buf.toString("utf-8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/**
 * Parse the chat-log produced by socket.ts:appendChatLog into a per-agent
 * trace. Sees both classic spawn_subagent flows (AGENT_SPAWN/DONE) and the
 * realtime/auto_swarm flows (AGENT_WORKING/COMPLETE). The orchestrator's own
 * load_skill calls land under the "main" pseudo-label.
 */
function parseSubagentWorkflow(log: string): SubagentTrace[] {
  if (!log) return [];
  const traces = new Map<string, SubagentTrace>();
  const ensure = (label: string): SubagentTrace => {
    let t = traces.get(label);
    if (!t) {
      t = { label, toolsUsed: [], skillsLoaded: [], completed: false };
      traces.set(label, t);
    }
    return t;
  };

  for (const m of log.matchAll(/AGENT_(?:SPAWN|WORKING): ([^\n]+)\n(?:\s+TASK:\s*([^\n]+))?/g)) {
    const t = ensure(m[1].trim());
    if (m[2] && !t.task) t.task = m[2].trim().slice(0, 240);
  }
  for (const m of log.matchAll(/^\[[^\]]+\]\s+([^\n]+?) → tool: ([^\n]+)$/gm)) {
    const t = ensure(m[1].trim());
    const tool = m[2].trim();
    if (!t.toolsUsed.includes(tool)) t.toolsUsed.push(tool);
  }
  for (const m of log.matchAll(/TOOL_CALL: load_skill(?: \(([^)]+)\))?[\s\S]{0,500}?"skill"\s*:\s*"([^"]+)"/g)) {
    const t = ensure((m[1] || "main").trim());
    if (!t.skillsLoaded.includes(m[2])) t.skillsLoaded.push(m[2]);
    if (!t.toolsUsed.includes("load_skill")) t.toolsUsed.push("load_skill");
  }
  for (const m of log.matchAll(/AGENT_(?:DONE|COMPLETE): ([^\n]+)/g)) {
    const t = traces.get(m[1].trim());
    if (t) t.completed = true;
  }
  for (const m of log.matchAll(/AGENT_ERROR: ([^:\n]+): ([^\n]+)/g)) {
    ensure(m[1].trim()).error = m[2].trim().slice(0, 200);
  }
  return Array.from(traces.values()).filter(
    (t) => t.toolsUsed.length > 0 || t.skillsLoaded.length > 0 || t.task || t.error,
  );
}

function collectLoadedSkills(traces: SubagentTrace[]): string[] {
  const set = new Set<string>();
  for (const t of traces) for (const s of t.skillsLoaded) set.add(s);
  return [...set];
}

// ─── Session summary ───

async function summariseSession(s: ChatSession): Promise<SessionSummary | null> {
  const userMsgs = s.messages.filter((m) => m.role === "user");
  const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
  if (userMsgs.length === 0 || assistantMsgs.length === 0) return null;
  const last = assistantMsgs[assistantMsgs.length - 1];
  const lastContent = typeof last.content === "string" ? last.content : "";
  if (isErrorReply(lastContent)) return null;
  const feedback: FeedbackEntry[] = [];
  for (const m of s.messages) {
    const fb = (m as any).feedback;
    if (!fb || (!fb.rating && !fb.comment)) continue;
    const content = typeof m.content === "string" ? m.content : "";
    feedback.push({
      role: m.role,
      rating: fb.rating,
      comment: fb.comment,
      excerpt: content.slice(0, 240),
    });
  }
  const log = await readChatLogTail(s.id);
  const subagentWorkflow = parseSubagentWorkflow(log);
  return {
    sessionId: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    userQueries: userMsgs
      .slice(0, 6)
      .map((m) => (typeof m.content === "string" ? m.content : "").slice(0, 600)),
    finalAssistant: lastContent.slice(0, 3000),
    feedback,
    subagentWorkflow,
  };
}

// ─── Existing skill loader ───

async function readAutoSkillContent(name: string): Promise<string | null> {
  const slug = sanitizeSlug(name);
  try {
    return await fs.readFile(path.join(SKILLS_DIR, slug, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

const EXISTING_SKILL_BODY_BUDGET = 4000;

async function loadExistingSkillSummaries(): Promise<{ name: string; description: string; source: string; body?: string }[]> {
  const skills = await getSkills();
  const out: { name: string; description: string; source: string; body?: string }[] = [];
  for (const s of skills) {
    let body: string | undefined;
    if (s.source === "auto") {
      const content = await readAutoSkillContent(s.name);
      if (content) body = content;
    }
    out.push({ name: s.name, description: s.description, source: s.source, body });
  }
  return out;
}

// ─── Prompt builders ───

function buildPrompt(
  candidates: (SessionSummary | null)[],
  existing: { name: string; description: string; source: string; body?: string }[],
  excludeSessionIds: Set<string> = new Set(),
): string {
  const candidatesBlock = candidates
    .filter((c): c is SessionSummary => !!c && !excludeSessionIds.has(c.sessionId))
    .map(
      (c, i) => {
        const feedbackBlock = c.feedback.length
          ? `\nhuman_feedback:\n${c.feedback
              .map((f) => {
                const tag = f.rating === "up" ? "👍 LIKED" : f.rating === "down" ? "👎 DISLIKED" : "💬 NOTE";
                const cmt = f.comment ? ` — comment: ${f.comment.replace(/\n/g, " ")}` : "";
                const ex = f.excerpt ? ` (on: ${f.excerpt.replace(/\n/g, " ")})` : "";
                return `- ${tag}${cmt}${ex}`;
              })
              .join("\n")}`
          : "";
        const workflowBlock = c.subagentWorkflow.length
          ? `\nsubagent_workflow (parsed from data/chat_logs/${c.sessionId}.log — invisible in final_assistant_excerpt):\n${c.subagentWorkflow
              .slice(0, 10)
              .map((w) => {
                const parts = [`- ${w.label}`];
                if (w.task) parts.push(`task="${w.task.replace(/"/g, "'")}"`);
                if (w.skillsLoaded.length) parts.push(`skills_loaded=[${w.skillsLoaded.join(", ")}]`);
                if (w.toolsUsed.length) {
                  const toolsView = w.toolsUsed.slice(0, 8).join(", ") + (w.toolsUsed.length > 8 ? ", …" : "");
                  parts.push(`tools_used=[${toolsView}]`);
                }
                if (w.error) parts.push(`error="${w.error.replace(/"/g, "'")}"`);
                else if (!w.completed) parts.push(`incomplete`);
                return parts.join(" | ");
              })
              .join("\n")}`
          : "";
        return `## Session ${i + 1}\nid: ${c.sessionId}\ntitle: ${c.title}\nuser_queries:\n${c.userQueries
          .map((q) => `- ${q.replace(/\n/g, " ")}`)
          .join("\n")}\nfinal_assistant_excerpt:\n${c.finalAssistant}${workflowBlock}${feedbackBlock}`;
      },
    )
    .join("\n\n---\n\n");

  const existingBlock = existing
    .map((e) => {
      const head = `- ${e.name} (${e.source}): ${e.description}`;
      if (!e.body) return head;
      const truncated = e.body.length > EXISTING_SKILL_BODY_BUDGET;
      const body = e.body.slice(0, EXISTING_SKILL_BODY_BUDGET);
      return `${head}\n  CURRENT SKILL.md${truncated ? " (truncated)" : ""}:\n  \`\`\`\n${body}\n  \`\`\``;
    })
    .join("\n");

  return `You are the SkillSynthesiser for the cowork agent. Recent successful chats just completed. Decide whether any of them embed a *reusable procedure* worth capturing as a SKILL.md, and (optionally) propose updates to an existing skill where the new conversation extends or corrects it.

Return STRICT JSON in this exact shape, with NO surrounding prose, NO markdown fences:

{"proposals":[{"kind":"create"|"update","name":"kebab-name","description":"one line, <=200 chars","content":"---\\nname: kebab-name\\ndescription: ...\\n---\\n\\n# Title\\n\\nbody...","basedOn":["session-id-1"],"rationale":"why this skill is useful"}]}

Rules:
- name must match [a-zA-Z0-9_-]+, max 64 chars.
- For update, name MUST exactly match an EXISTING skill below.
- NEVER overwrite a skill whose source is custom, clawhub, claude, or openclaw — only propose updates to skills with source "auto".
- Skip casual chats / one-off Q&A that don't generalise. Quality > quantity.
- If nothing is worth capturing, return {"proposals":[]}.
- content MUST be a complete SKILL.md including YAML frontmatter (name + description) followed by markdown body. Body <= 100,000 chars.
- Treat human_feedback as authoritative: 👍 LIKED responses indicate workflows worth capturing or reinforcing; 👎 DISLIKED responses indicate the procedure failed or misled the user — DO NOT distil a skill from those, and if an existing auto-skill produced the disliked behaviour, propose an update that addresses the comment.
- If subagent_workflow is non-empty, the session ran a multi-agent topology. The final_assistant_excerpt is the orchestrator's merged summary and HIDES which sub-agent did what. Use the workflow block as ground truth for the actual procedure: capture the agent labels, the order they ran, the skills_loaded each used, and any errors. A skill body for a multi-agent workflow should prescribe the topology (which roles to spawn, in what order, with which skills loaded), not just the outcome. If skills_loaded names an existing auto-skill that produced a great result, prefer "update" to refine it over creating a near-duplicate "create".

EXISTING SKILLS:
${existingBlock || "(none)"}

CANDIDATE CHAT SESSIONS:
${candidatesBlock}`;
}

// ─── Reasoning / JSON extraction ───

function stripReasoning(text: string): string {
  let t = text;
  t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  t = t.replace(/<reflection>[\s\S]*?<\/reflection>/gi, "");
  const openIdx = t.search(/<think(?:ing)?>/i);
  if (openIdx >= 0) {
    const closeMatch = t.slice(openIdx).match(/<\/think(?:ing)?>/i);
    if (closeMatch && typeof closeMatch.index === "number") {
      t = t.slice(0, openIdx) + t.slice(openIdx + closeMatch.index + closeMatch[0].length);
    } else {
      t = t.slice(0, openIdx);
    }
  }
  return t.trim();
}

function extractJson(text: string): any {
  let t = stripReasoning(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) t = fence[1].trim();

  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object found");

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("no balanced JSON object found");
}

// ─── Validation ───

function validateProposal(p: any, existing: { name: string; source: string }[]): { ok: true; value: Proposal } | { ok: false; reason: string } {
  if (!p || typeof p !== "object") return { ok: false, reason: "proposal not object" };
  if (p.kind !== "create" && p.kind !== "update") return { ok: false, reason: "bad kind" };
  if (typeof p.name !== "string" || !NAME_RE.test(p.name) || p.name.length > MAX_NAME_LEN) {
    return { ok: false, reason: `bad name: ${p.name}` };
  }
  if (typeof p.description !== "string" || !p.description.trim() || p.description.length > MAX_DESC_LEN) {
    return { ok: false, reason: `bad description for ${p.name}` };
  }
  if (typeof p.content !== "string" || p.content.length === 0 || p.content.length > MAX_BODY_CHARS) {
    return { ok: false, reason: `bad content for ${p.name}` };
  }
  const fm = p.content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, reason: `${p.name}: missing frontmatter` };
  try {
    const parsed = yaml.load(fm[1]);
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: `${p.name}: frontmatter not object` };
  } catch (e: any) {
    return { ok: false, reason: `${p.name}: yaml parse error: ${e.message}` };
  }
  const match = existing.find((e) => e.name === p.name);
  if (p.kind === "create" && match) {
    return { ok: false, reason: `${p.name}: name already exists (source=${match.source})` };
  }
  if (p.kind === "update") {
    if (!match) return { ok: false, reason: `${p.name}: update target does not exist` };
    if (match.source !== "auto") return { ok: false, reason: `${p.name}: refuse to update non-auto skill` };
  }
  if (!Array.isArray(p.basedOn)) p.basedOn = [];
  return { ok: true, value: p as Proposal };
}

// ─── Skill writing ───

async function writeNewAutoSkill(p: Proposal, model: string): Promise<void> {
  const slug = sanitizeSlug(p.name);
  const skillDir = path.join(SKILLS_DIR, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), p.content, "utf-8");

  const skills = await getSkills();
  const settings = await getSettings();
  const requireApproval = settings.skillAutoUpdateRequireApproval !== false;

  const skill: Skill = {
    id: uuid(),
    name: p.name,
    description: p.description,
    source: "auto",
    script: p.name,
    enabled: !requireApproval,
    installedAt: new Date().toISOString(),
    reviewStatus: requireApproval ? "pending" : "approved",
    autoMeta: {
      kind: "create",
      basedOn: p.basedOn,
      generatedAt: new Date().toISOString(),
      model,
      rationale: p.rationale,
    },
  };
  skills.push(skill);
  await saveSkills(skills);
}

async function writeProposedUpdate(p: Proposal, model: string): Promise<void> {
  const slug = sanitizeSlug(p.name);
  const skillDir = path.join(SKILLS_DIR, slug);
  await fs.mkdir(skillDir, { recursive: true });
  const proposedPath = path.join(skillDir, "SKILL.md.proposed");
  await fs.writeFile(proposedPath, p.content, "utf-8");

  const skills = await getSkills();
  const settings = await getSettings();
  const requireApproval = settings.skillAutoUpdateRequireApproval !== false;
  const idx = skills.findIndex((s) => s.name === p.name && s.source === "auto");
  if (idx < 0) {
    return writeNewAutoSkill(p, model);
  }
  if (!requireApproval) {
    await fs.rename(proposedPath, path.join(skillDir, "SKILL.md"));
    skills[idx].description = p.description;
    skills[idx].reviewStatus = "approved";
    skills[idx].enabled = true;
    skills[idx].autoMeta = {
      kind: "update",
      basedOn: p.basedOn,
      generatedAt: new Date().toISOString(),
      model,
      rationale: p.rationale,
    };
  } else {
    skills[idx].reviewStatus = "pending";
    skills[idx].autoMeta = {
      kind: "update",
      basedOn: p.basedOn,
      generatedAt: new Date().toISOString(),
      model,
      proposedPath: "SKILL.md.proposed",
      rationale: p.rationale,
    };
  }
  await saveSkills(skills);
}

// ─── Approval / Rejection ───

export async function approveSkill(id: string): Promise<{ ok: boolean; error?: string }> {
  const skills = await getSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false, error: "not found" };
  const skill = skills[idx];
  if (skill.source !== "auto") return { ok: false, error: "not an auto-generated skill" };
  const slug = sanitizeSlug(skill.name);
  const skillDir = path.join(SKILLS_DIR, slug);

  if (skill.autoMeta?.kind === "update" && skill.autoMeta.proposedPath) {
    const proposedPath = path.join(skillDir, skill.autoMeta.proposedPath);
    const livePath = path.join(skillDir, "SKILL.md");
    try {
      await fs.rename(proposedPath, livePath);
    } catch (e: any) {
      return { ok: false, error: `rename failed: ${e.message}` };
    }
    if (skill.autoMeta) skill.autoMeta.proposedPath = undefined;
  }
  skill.enabled = true;
  skill.reviewStatus = "approved";
  await saveSkills(skills);
  return { ok: true };
}

export async function rejectSkill(id: string): Promise<{ ok: boolean; error?: string }> {
  const skills = await getSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false, error: "not found" };
  const skill = skills[idx];
  if (skill.source !== "auto") return { ok: false, error: "not an auto-generated skill" };
  const slug = sanitizeSlug(skill.name);
  const skillDir = path.join(SKILLS_DIR, slug);

  if (skill.autoMeta?.kind === "update" && skill.autoMeta.proposedPath) {
    try {
      await fs.unlink(path.join(skillDir, skill.autoMeta.proposedPath));
    } catch {}
    skill.reviewStatus = "approved";
    skill.autoMeta.proposedPath = undefined;
    await saveSkills(skills);
    return { ok: true };
  }

  // Create rejection: delete the whole skill folder + drop registry row
  try {
    await fs.rm(skillDir, { recursive: true, force: true });
  } catch {}
  skills.splice(idx, 1);
  await saveSkills(skills);
  return { ok: true };
}

export async function getProposedDiff(id: string): Promise<{ ok: boolean; current?: string; proposed?: string; error?: string }> {
  const skills = await getSkills();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return { ok: false, error: "not found" };
  if (skill.source !== "auto") return { ok: false, error: "not auto" };
  const slug = sanitizeSlug(skill.name);
  const skillDir = path.join(SKILLS_DIR, slug);
  let current = "";
  let proposed = "";
  try { current = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8"); } catch {}
  if (skill.autoMeta?.proposedPath) {
    try { proposed = await fs.readFile(path.join(skillDir, skill.autoMeta.proposedPath), "utf-8"); } catch {}
  } else if (skill.autoMeta?.kind === "create") {
    proposed = current;
    current = "";
  }
  return { ok: true, current, proposed };
}

// ─── Remediation (fix skills from 👎 feedback) ───

const MAX_REMEDIATIONS_PER_RUN = 5;
const REMEDIATION_MIN_SCORE = 2;

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []).filter(
    (t) => !["the", "and", "for", "with", "this", "that", "your", "from", "into", "have", "should", "would", "could", "about", "user", "agent", "skill", "code", "use", "using"].includes(t),
  );
}

function selectRemediationTarget(
  excerpt: string,
  comment: string,
  autoSkills: { name: string; description: string }[],
  contents: Map<string, string>,
): { name: string; score: number } | null {
  const needle = new Set(tokenize(`${excerpt} ${comment}`));
  if (needle.size === 0) return null;
  let best: { name: string; score: number } | null = null;
  for (const sk of autoSkills) {
    const hay = `${sk.name} ${sk.description} ${(contents.get(sk.name) || "").slice(0, 4000)}`;
    const hayTokens = new Set(tokenize(hay));
    let hits = 0;
    for (const t of needle) if (hayTokens.has(t)) hits++;
    if (!best || hits > best.score) best = { name: sk.name, score: hits };
  }
  if (!best || best.score < REMEDIATION_MIN_SCORE) return null;
  return best;
}

function buildRemediationPrompt(
  skillName: string,
  currentSkillMd: string,
  excerpt: string,
  comment: string,
  workflow: SubagentTrace[] = [],
): string {
  const workflowHint = workflow.length
    ? `\nSUB-AGENT WORKFLOW (parsed from the session's chat log — the orchestrator's reply hides this):\n${workflow
        .slice(0, 8)
        .map((w) => {
          const skills = w.skillsLoaded.length ? ` skills_loaded=[${w.skillsLoaded.join(", ")}]` : "";
          const tools = w.toolsUsed.length ? ` tools=[${w.toolsUsed.slice(0, 6).join(", ")}]` : "";
          const status = w.error ? ` ERROR="${w.error.replace(/"/g, "'")}"` : w.completed ? "" : " (incomplete)";
          return `- ${w.label}${skills}${tools}${status}`;
        })
        .join("\n")}\n`
    : "";
  return `You are fixing an existing SKILL.md because a user marked an assistant response that this skill produced as 👎 NOT HELPFUL and explained why.

Your job: rewrite the skill so the same failure does not recur. Preserve everything that still works. Address the user's complaint directly — change procedures, add a guard, remove a misleading instruction, or clarify scope as needed.

Return STRICT JSON, NO surrounding prose, NO markdown fences:
{"name":"${skillName}","description":"<=200 chars","content":"---\\nname: ${skillName}\\ndescription: ...\\n---\\n\\n# Title\\n\\nbody...","rationale":"what you changed and why"}

Rules:
- name MUST equal "${skillName}" exactly.
- content MUST be a complete SKILL.md with YAML frontmatter (name + description) followed by markdown body. Body <= 100,000 chars.
- Do not delete the skill — only revise it.
- If the complaint is unrelated to this skill (wrong target), return {"name":"${skillName}","skip":true,"reason":"<short>"} instead.
- If the failure was at the orchestration layer (wrong sub-agent loaded the skill, wrong order, missing prerequisite), describe the correction in the skill body — sub-agents see this skill via load_skill, so prerequisites and ordering belong here.

CURRENT SKILL (${skillName}):
\`\`\`
${currentSkillMd.slice(0, 30000)}
\`\`\`
${workflowHint}
DISLIKED ASSISTANT RESPONSE EXCERPT:
${excerpt}

USER COMMENT (what went wrong / what to fix):
${comment}`;
}

interface RemediationOutcome {
  updated: number;
  skipped: number;
  reasons: string[];
  consumedSessionIds: Set<string>;
}

async function runRemediations(
  candidates: SessionSummary[],
  model: string,
): Promise<RemediationOutcome> {
  const out: RemediationOutcome = { updated: 0, skipped: 0, reasons: [], consumedSessionIds: new Set() };

  type Target = { sessionId: string; excerpt: string; comment: string; candidate: SessionSummary };
  const targets: Target[] = [];
  for (const c of candidates) {
    for (const f of c.feedback) {
      if (f.rating === "down" && f.comment && f.comment.trim() && f.role === "assistant") {
        targets.push({
          sessionId: c.sessionId,
          excerpt: (f.excerpt || c.finalAssistant).slice(0, 1200),
          comment: f.comment.trim(),
          candidate: c,
        });
        break;
      }
    }
  }
  if (targets.length === 0) return out;

  const allSkills = await getSkills();
  const autoSkills = allSkills.filter((s) => s.source === "auto").map((s) => ({ name: s.name, description: s.description }));
  if (autoSkills.length === 0) {
    for (const t of targets) {
      out.skipped++;
      out.reasons.push(`remediation skipped (${t.sessionId}): no auto skill exists to update`);
    }
    return out;
  }
  const autoSkillNames = new Set(autoSkills.map((s) => s.name));

  const contents = new Map<string, string>();
  for (const s of autoSkills) {
    const c = await readAutoSkillContent(s.name);
    if (c) contents.set(s.name, c);
  }

  const capped = targets.slice(0, MAX_REMEDIATIONS_PER_RUN);
  if (targets.length > capped.length) {
    out.reasons.push(`remediation cap reached: ${targets.length - capped.length} 👎 sessions deferred to next run`);
  }

  for (const t of capped) {
    const loadedAuto = collectLoadedSkills(t.candidate.subagentWorkflow).filter((n) => autoSkillNames.has(n));
    let pick: { name: string; score: number } | null = null;
    let strategy: "chatlog-unique" | "chatlog-subset" | "token-overlap" = "token-overlap";
    if (loadedAuto.length === 1) {
      pick = { name: loadedAuto[0], score: Number.POSITIVE_INFINITY };
      strategy = "chatlog-unique";
    } else if (loadedAuto.length > 1) {
      const subset = autoSkills.filter((s) => loadedAuto.includes(s.name));
      pick = selectRemediationTarget(t.excerpt, t.comment, subset, contents);
      strategy = "chatlog-subset";
    } else {
      pick = selectRemediationTarget(t.excerpt, t.comment, autoSkills, contents);
    }
    if (!pick) {
      out.skipped++;
      out.reasons.push(`remediation skipped (${t.sessionId}): no auto skill matched the disliked turn`);
      continue;
    }
    const skillMd = contents.get(pick.name);
    if (!skillMd) {
      out.skipped++;
      out.reasons.push(`remediation skipped (${t.sessionId}): could not read ${pick.name}/SKILL.md`);
      continue;
    }

    const prompt = buildRemediationPrompt(pick.name, skillMd, t.excerpt, t.comment, t.candidate.subagentWorkflow);
    const reply = await callTigerBot(
      [{ role: "user", content: prompt }],
      "You are a careful skill remediator. Output strict JSON only.",
    );
    const replyContent = typeof reply.content === "string" ? reply.content : "";
    if (isErrorReply(replyContent)) {
      out.skipped++;
      out.reasons.push(`remediation LLM error for ${pick.name}: ${replyContent.slice(0, 120)}`);
      continue;
    }

    let parsed: any;
    try {
      parsed = extractJson(replyContent);
    } catch (e: any) {
      out.skipped++;
      out.reasons.push(`remediation parse failed for ${pick.name}: ${e.message}`);
      continue;
    }

    if (parsed?.skip === true) {
      out.skipped++;
      out.reasons.push(`remediation declined for ${pick.name}: ${String(parsed.reason || "model said skip")}`);
      continue;
    }

    const proposal: any = {
      kind: "update",
      name: pick.name,
      description: parsed?.description,
      content: parsed?.content,
      basedOn: [t.sessionId],
      rationale: `remediation from 👎 comment: ${t.comment.slice(0, 160)}${parsed?.rationale ? ` | ${String(parsed.rationale).slice(0, 200)}` : ""}`,
    };
    const existingForCollision = allSkills.map((s) => ({ name: s.name, source: s.source }));
    const v = validateProposal(proposal, existingForCollision);
    if (!v.ok) {
      out.skipped++;
      out.reasons.push(`remediation invalid for ${pick.name}: ${v.reason}`);
      continue;
    }
    try {
      await writeProposedUpdate(v.value, model);
      out.updated++;
      out.consumedSessionIds.add(t.sessionId);
      out.reasons.push(`remediated ${pick.name} from 👎 in ${t.sessionId} (target picked via ${strategy})`);
    } catch (e: any) {
      out.skipped++;
      out.reasons.push(`remediation write failed for ${pick.name}: ${e.message}`);
    }
  }

  return out;
}

// ─── Main synthesis ───

export async function runSkillSynthesis(opts: { manual?: boolean } = {}): Promise<RunSummary> {
  if (inflight) return { ok: false, created: 0, updated: 0, skipped: 0, reasons: ["already-running"] };
  inflight = true;
  try {
    const settings = await getSettings();
    if (!settings.skillAutoUpdateEnabled) {
      return { ok: false, created: 0, updated: 0, skipped: 0, reasons: ["disabled"] };
    }

    const sessions = await getChatHistory();
    const cursor = settings.skillAutoUpdateCursor || "1970-01-01T00:00:00.000Z";
    const cap = Math.max(1, settings.skillAutoUpdateMaxCandidates ?? 30);
    const sortedAsc = sessions.slice().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    // Manual "Run Now" ignores the cursor so users can re-evaluate current chats against existing skills.
    const fresh = opts.manual ? sortedAsc : sortedAsc.filter((s) => s.updatedAt > cursor);
    const settled = await Promise.all(fresh.map(summariseSession));
    const candidates: SessionSummary[] = settled.filter((c): c is SessionSummary => !!c).slice(-cap);

    if (candidates.length === 0) {
      const summaryMsg = opts.manual ? "no successful sessions found" : "no new successful sessions";
      await saveSettings({ ...settings, skillAutoUpdateLastRunAt: new Date().toISOString(), skillAutoUpdateLastRunSummary: summaryMsg });
      return { ok: true, created: 0, updated: 0, skipped: 0, reasons: [summaryMsg], summary: summaryMsg };
    }

    const model = settings.tigerBotModel || "unknown";

    // Pass 1: remediation — sessions with 👎+comment drive a focused single-skill rewrite.
    const remediation = await runRemediations(candidates, model);

    const remainingForSynthesis = candidates.filter((c) => !remediation.consumedSessionIds.has(c.sessionId));
    if (remainingForSynthesis.length === 0) {
      const newCursor = candidates[candidates.length - 1].updatedAt;
      const summaryMsg = `created=0 updated=${remediation.updated} skipped=${remediation.skipped} candidates=${candidates.length} (all consumed by remediation)`;
      await saveSettings({
        ...settings,
        skillAutoUpdateCursor: newCursor,
        skillAutoUpdateLastRunAt: new Date().toISOString(),
        skillAutoUpdateLastRunSummary: summaryMsg + (remediation.reasons.length ? ` | ${remediation.reasons.slice(0, 3).join("; ")}` : ""),
      });
      return { ok: true, created: 0, updated: remediation.updated, skipped: remediation.skipped, reasons: remediation.reasons, summary: summaryMsg };
    }

    const existing = await loadExistingSkillSummaries();
    const prompt = buildPrompt(candidates, existing, remediation.consumedSessionIds);

    const reply = await callTigerBot(
      [{ role: "user", content: prompt }],
      "You are a careful skill synthesiser. Output strict JSON only.",
    );
    const replyContent = typeof reply.content === "string" ? reply.content : "";
    if (isErrorReply(replyContent)) {
      const summaryMsg = `LLM error: ${replyContent.slice(0, 200)}`;
      await saveSettings({ ...settings, skillAutoUpdateLastRunAt: new Date().toISOString(), skillAutoUpdateLastRunSummary: summaryMsg });
      return {
        ok: false,
        created: 0,
        updated: remediation.updated,
        skipped: remediation.skipped + candidates.length,
        reasons: [...remediation.reasons, summaryMsg],
        error: replyContent,
        summary: summaryMsg,
      };
    }

    let parsed: any;
    try {
      parsed = extractJson(replyContent);
    } catch (e: any) {
      const stripped = stripReasoning(replyContent);
      const head = stripped.trim().toLowerCase().slice(0, 200);
      const looksEmpty =
        stripped.trim().length === 0 ||
        head.includes("no proposals") ||
        head.includes("nothing to propose") ||
        head.includes("no skill") ||
        head.includes("no worthwhile") ||
        head.includes("not worth");
      if (looksEmpty) {
        parsed = { proposals: [] };
      } else {
        const replyPreview = replyContent.slice(0, 300).replace(/\s+/g, " ");
        console.error(`[SkillSynth] JSON parse failed. LLM reply (first 300 chars): ${replyPreview}`);
        const summaryMsg = `LLM JSON parse failed: ${e.message} | reply head: ${replyPreview.slice(0, 120)}`;
        await saveSettings({ ...settings, skillAutoUpdateLastRunAt: new Date().toISOString(), skillAutoUpdateLastRunSummary: summaryMsg });
        return {
          ok: false,
          created: 0,
          updated: remediation.updated,
          skipped: remediation.skipped + candidates.length,
          reasons: [...remediation.reasons, summaryMsg],
          error: e.message,
          summary: summaryMsg,
        };
      }
    }
    const proposals: any[] = Array.isArray(parsed?.proposals) ? parsed.proposals : [];

    let created = 0;
    let updated = remediation.updated;
    let skipped = remediation.skipped;
    const reasons: string[] = [...remediation.reasons];
    const existingForCollision = (await getSkills()).map((s) => ({ name: s.name, source: s.source }));

    for (const raw of proposals) {
      const v = validateProposal(raw, existingForCollision);
      if (!v.ok) { skipped++; reasons.push(v.reason); continue; }
      try {
        if (v.value.kind === "create") {
          await writeNewAutoSkill(v.value, model);
          created++;
          existingForCollision.push({ name: v.value.name, source: "auto" });
        } else {
          await writeProposedUpdate(v.value, model);
          updated++;
        }
      } catch (e: any) {
        skipped++;
        reasons.push(`${v.value.name}: write failed ${e.message}`);
      }
    }

    const newCursor = candidates[candidates.length - 1].updatedAt;
    const summaryMsg = `created=${created} updated=${updated} skipped=${skipped} candidates=${candidates.length}`;
    await saveSettings({
      ...settings,
      skillAutoUpdateCursor: newCursor,
      skillAutoUpdateLastRunAt: new Date().toISOString(),
      skillAutoUpdateLastRunSummary: summaryMsg + (reasons.length ? ` | ${reasons.slice(0, 3).join("; ")}` : ""),
    });
    return { ok: true, created, updated, skipped, reasons, summary: summaryMsg };
  } finally {
    inflight = false;
  }
}
