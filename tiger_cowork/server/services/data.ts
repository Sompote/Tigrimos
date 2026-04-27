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
export interface ChatMessageFeedback {
  rating?: "up" | "down";
  comment?: string;
  submittedAt?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; timestamp: string; files?: string[]; feedback?: ChatMessageFeedback }>;
  createdAt: string;
  updatedAt: string;
  skillCandidate?: boolean;
  skillFeedback?: "positive" | "negative";
  projectId?: string;
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
  subAgentMode?: string; // "auto" | "auto_create" | "manual" | "realtime" | "auto_swarm"
  subAgentModel?: string;
  subAgentMaxDepth?: number;
  subAgentMaxConcurrent?: number;
  subAgentTimeout?: number;
  subAgentConfigFile?: string;
  remoteEnabled?: boolean; // master toggle – when false, remote token auth and remote UI are disabled
  remoteAgentConfig?: string; // YAML config file for incoming remote tasks ("" = simple chat)
  remoteSystemPrompt?: string; // hidden system prompt prepended to incoming remote tasks — instructs how the remote agent answers, invisible to the caller
  remoteTaskMaxRetries?: number; // max re-delegations on subAgentTimeout for realtime remote tasks (default 2 → up to 3 total attempts)
  remoteInstances?: Array<{ id: string; name: string; url: string; token: string }>;
  remoteToken?: string;  // this machine's token for incoming remote connections (separate from accessToken)
  localFileMounts?: Array<{
    id: string;
    path: string;           // absolute path on host machine
    label: string;          // display name
    permissions: "read" | "readwrite";  // what the agent can do
    enabled: boolean;
  }>;
  skillAutoUpdateHumanFeedbackEnabled?: boolean; // when on, chat UI shows thumb up/down + comment per assistant message; feedback is fed into the synthesiser prompt
  [key: string]: any;
}

// Per-project settings overrides using AsyncLocalStorage for proper async scoping
import { AsyncLocalStorage } from "async_hooks";
const _settingsOverrideStore = new AsyncLocalStorage<Partial<Settings>>();

export function runWithSettingsOverride<T>(overrides: Partial<Settings>, fn: () => T): T {
  return _settingsOverrideStore.run(overrides, fn);
}

export async function getSettings(): Promise<Settings> {
  const settings = await readJSON("settings.json") as Settings;
  // Apply defaults for skill auto-update (so new installs start with these on)
  if (settings.skillAutoUpdateEnabled === undefined) settings.skillAutoUpdateEnabled = true;
  if (settings.skillAutoUpdateIntervalMinutes === undefined) settings.skillAutoUpdateIntervalMinutes = 5;
  if (settings.skillAutoUpdateRequireApproval === undefined) settings.skillAutoUpdateRequireApproval = true;
  if (settings.skillAutoUpdateHumanFeedbackEnabled === undefined) settings.skillAutoUpdateHumanFeedbackEnabled = true;
  const overrides = _settingsOverrideStore.getStore();
  if (overrides) {
    return { ...settings, ...overrides };
  }
  return settings;
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
  systemPrompt?: string; // Custom system prompt prepended to AI context for this project
  // Per-project agent overrides (if set, override system settings)
  agentOverride?: {
    enabled?: boolean;
    subAgentMode?: string;
    subAgentConfigFile?: string;
    autoArchitectureType?: string;
    autoAgentCount?: number | string;
    autoProtocols?: string[];
  };
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
  source: "claude" | "openclaw" | "custom" | "clawhub" | "auto";
  script: string;
  enabled: boolean;
  installedAt: string;
  // Auto-generated skills only:
  reviewStatus?: "pending" | "approved" | "rejected";
  autoMeta?: {
    kind: "create" | "update";
    basedOn: string[];     // chat session IDs
    generatedAt: string;
    model: string;
    proposedPath?: string; // SKILL.md.proposed for updates pending approval
    rationale?: string;
  };
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
