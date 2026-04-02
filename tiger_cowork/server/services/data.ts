import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.resolve("data");

async function readJSON(file: string): Promise<any> {
  const fp = path.join(DATA_DIR, file);
  try {
    await fs.access(fp);
    const content = await fs.readFile(fp, "utf-8");
    return JSON.parse(content);
  } catch {
    return file.endsWith("settings.json") ? {} : [];
  }
}

async function writeJSON(file: string, data: any): Promise<void> {
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Chat history
export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; timestamp: string; files?: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export async function getChatHistory(): Promise<ChatSession[]> {
  return readJSON("chat_history.json");
}

export async function saveChatHistory(sessions: ChatSession[]): Promise<void> {
  await writeJSON("chat_history.json", sessions);
}

// Tasks (cron)
export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  createdAt: string;
}

export async function getTasks(): Promise<ScheduledTask[]> {
  return readJSON("tasks.json");
}

export async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  await writeJSON("tasks.json", tasks);
}

// Settings
export interface Settings {
  sandboxDir: string;
  tigerBotApiKey: string;
  tigerBotModel: string;
  tigerBotApiUrl?: string;
  mcpTools: Array<{ name: string; url: string; enabled: boolean; type?: string; headers?: Record<string, string> }>;
  webSearchEnabled: boolean;
  webSearchApiKey?: string;
  webSearchEngine?: string;
  pythonPath?: string;
  subAgentEnabled?: boolean;
  subAgentMode?: string; // "auto" | "manual" | "realtime"
  subAgentModel?: string;
  subAgentMaxDepth?: number;
  subAgentMaxConcurrent?: number;
  subAgentTimeout?: number;
  subAgentConfigFile?: string;
  [key: string]: any;
}

export async function getSettings(): Promise<Settings> {
  return readJSON("settings.json");
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJSON("settings.json", settings);
}

// Projects
export interface Project {
  id: string;
  name: string;
  description: string;
  workingFolder: string;
  memory: string;
  skills: string[];
  createdAt: string;
  updatedAt: string;
}

export async function getProjects(): Promise<Project[]> {
  return readJSON("projects.json");
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await writeJSON("projects.json", projects);
}

// File Access Tokens
export interface FileToken {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export async function getFileTokens(): Promise<FileToken[]> {
  return readJSON("file_tokens.json");
}

export async function saveFileTokens(tokens: FileToken[]): Promise<void> {
  await writeJSON("file_tokens.json", tokens);
}

export function generateToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 48; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export async function isValidFileToken(token: string): Promise<boolean> {
  const tokens = await getFileTokens();
  return tokens.some((t) => t.token === token);
}

// Skills
export interface Skill {
  id: string;
  name: string;
  description: string;
  source: "claude" | "openclaw" | "custom" | "clawhub";
  script: string;
  enabled: boolean;
  installedAt: string;
}

export async function getSkills(): Promise<Skill[]> {
  return readJSON("skills.json");
}

export async function saveSkills(skills: Skill[]): Promise<void> {
  await writeJSON("skills.json", skills);
}

// Agent History (JSONL-based, per-session folder)
const AGENT_HISTORY_DIR = path.join(DATA_DIR, "agent_history");

export async function ensureAgentHistoryDir(sessionId: string): Promise<string> {
  const dir = path.join(AGENT_HISTORY_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function appendAgentHistory(sessionId: string, file: string, entry: any): Promise<void> {
  const dir = await ensureAgentHistoryDir(sessionId);
  const fp = path.join(dir, file);
  await fs.appendFile(fp, JSON.stringify(entry) + "\n");
}

export async function readAgentHistory(sessionId: string, file: string): Promise<any[]> {
  const fp = path.join(AGENT_HISTORY_DIR, sessionId, file);
  try {
    const content = await fs.readFile(fp, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function deleteAgentHistory(sessionId: string): Promise<void> {
  const dir = path.join(AGENT_HISTORY_DIR, sessionId);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function flushAgentHistory(_sessionId: string): Promise<void> {
  // JSONL is append-per-call, no buffering needed. Reserved for future batching.
}

// Checkpoint directory for tool loop recovery
const CHECKPOINT_DIR = path.join(DATA_DIR, "checkpoints");

export async function getCheckpointDir(): Promise<string> {
  await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
  return CHECKPOINT_DIR;
}
