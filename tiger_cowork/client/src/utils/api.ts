const BASE = "/api";

export function getAccessToken(): string {
  return localStorage.getItem("access_token") || "";
}

export function setAccessToken(token: string) {
  localStorage.setItem("access_token", token);
}

export function clearAccessToken() {
  localStorage.removeItem("access_token");
}

async function request(path: string, options?: RequestInit) {
  const token = getAccessToken();
  const hasBody = options?.body !== undefined && options?.body !== null;
  const headers: Record<string, string> = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers || {}) },
  });
  if (res.status === 401) {
    clearAccessToken();
    window.location.reload();
    throw new Error("Unauthorized");
  }
  return res.json();
}

// Build a sandbox URL with the access token for file serving
export function sandboxUrl(filePath: string, cacheBust = false): string {
  const token = getAccessToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (cacheBust) params.set("t", Date.now().toString());
  const qs = params.toString();
  return `/sandbox/${filePath}${qs ? `?${qs}` : ""}`;
}

export const api = {
  // Chat
  getSessions: () => request("/chat/sessions"),
  getSession: (id: string) => request(`/chat/sessions/${id}`),
  createSession: (title?: string) => request("/chat/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => request(`/chat/sessions/${id}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) => request(`/chat/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),

  // Files
  listFiles: (path?: string) => request(`/files?path=${encodeURIComponent(path || "")}`),
  readFile: (path: string) => request(`/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) => request("/files/write", { method: "POST", body: JSON.stringify({ path, content }) }),
  deleteFile: (path: string) => request(`/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  mkdir: (path: string) => request("/files/mkdir", { method: "POST", body: JSON.stringify({ path }) }),
  previewFile: (path: string) => request(`/files/preview?path=${encodeURIComponent(path)}`),
  downloadUrl: (path: string) => {
    const token = getAccessToken();
    return `/api/files/download?path=${encodeURIComponent(path)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  },
  uploadFile: async (file: File, destPath: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("path", destPath);
    const token = getAccessToken();
    const res = await fetch(`${BASE}/files/upload`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  },

  // Python
  runPython: (code: string) => request("/python/run", { method: "POST", body: JSON.stringify({ code }) }),

  // Tasks
  getTasks: () => request("/tasks"),
  getActiveTasks: () => request("/tasks/active"),
  killActiveTask: (id: string) => request(`/tasks/active/${id}/kill`, { method: "POST" }),
  createTask: (data: any) => request("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: any) => request(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),

  // Skills
  getSkills: () => request("/skills"),
  getSkillCatalog: () => request("/skills/catalog"),
  installSkill: (data: any) => request("/skills", { method: "POST", body: JSON.stringify(data) }),
  uploadSkill: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const token = getAccessToken();
    const res = await fetch(`${BASE}/skills/upload`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  },
  updateSkill: (id: string, data: any) => request(`/skills/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSkill: (id: string) => request(`/skills/${id}`, { method: "DELETE" }),

  // Clawhub
  clawhubSearch: (query: string, limit = 10) => request(`/clawhub/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  clawhubInstall: (slug: string, force = false) => request("/clawhub/install", { method: "POST", body: JSON.stringify({ slug, force }) }),
  clawhubInfo: (slug: string) => request(`/clawhub/info/${encodeURIComponent(slug)}`),
  clawhubSkills: () => request("/clawhub/skills"),

  // Chat file upload
  chatUpload: async (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const token = getAccessToken();
    const res = await fetch(`${BASE}/files/chat-upload`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  },

  // Projects
  getProjects: () => request("/projects"),
  getProject: (id: string) => request(`/projects/${id}`),
  createProject: (data: any) => request("/projects", { method: "POST", body: JSON.stringify(data) }),
  updateProject: (id: string, data: any) => request(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteProject: (id: string) => request(`/projects/${id}`, { method: "DELETE" }),
  getProjectMemory: (id: string) => request(`/projects/${id}/memory`),
  saveProjectMemory: (id: string, content: string) => request(`/projects/${id}/memory`, { method: "PUT", body: JSON.stringify({ content }) }),
  generateProjectMemory: (id: string) => request(`/projects/${id}/memory/generate`, { method: "POST" }),
  getProjectFiles: (id: string, path?: string) => request(`/projects/${id}/files?path=${encodeURIComponent(path || "")}`),
  projectMkdir: (id: string, name: string, subPath?: string) => request(`/projects/${id}/files/mkdir`, { method: "POST", body: JSON.stringify({ name, path: subPath || "" }) }),
  projectDeleteFile: (id: string, filePath: string) => request(`/projects/${id}/files?path=${encodeURIComponent(filePath)}`, { method: "DELETE" }),
  projectDownloadUrl: (id: string, filePath: string) => {
    const token = getAccessToken();
    return `/api/projects/${id}/files/download?path=${encodeURIComponent(filePath)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  },
  projectSandboxPath: (id: string, filePath: string) => request(`/projects/${id}/files/sandbox-path?path=${encodeURIComponent(filePath)}`),
  projectUploadFile: async (id: string, file: File, subPath?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (subPath) form.append("path", subPath);
    const token = getAccessToken();
    const res = await fetch(`${BASE}/projects/${id}/files/upload`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  },

  // Settings
  getSettings: () => request("/settings"),
  saveSettings: (data: any) => request("/settings", { method: "PUT", body: JSON.stringify(data) }),
  testConnection: (data: any) => request("/settings/test-connection", { method: "POST", body: JSON.stringify(data) }),
  getClaudeCodeOAuth: () => request("/settings/claude-code-oauth"),

  // Tools
  webSearch: (query: string) => request("/tools/web-search", { method: "POST", body: JSON.stringify({ query }) }),

  // File Access Tokens
  getFileTokens: () => request("/settings/file-tokens"),
  createFileToken: (name: string) => request("/settings/file-tokens", { method: "POST", body: JSON.stringify({ name }) }),
  deleteFileToken: (id: string) => request(`/settings/file-tokens/${id}`, { method: "DELETE" }),
  regenerateFileToken: (id: string) => request(`/settings/file-tokens/${id}/regenerate`, { method: "POST" }),

  // MCP
  mcpStatus: () => request("/settings/mcp/status"),
  mcpConnect: (name: string, url: string, type?: string, headers?: Record<string, string>) => request("/settings/mcp/connect", { method: "POST", body: JSON.stringify({ name, url, type, headers }) }),
  mcpDisconnect: (name: string) => request("/settings/mcp/disconnect", { method: "POST", body: JSON.stringify({ name }) }),
  mcpReconnectAll: () => request("/settings/mcp/reconnect-all", { method: "POST" }),

  // Agent configs
  getAgentConfigs: () => request("/agents"),
  getAgentConfig: (filename: string) => request(`/agents/${encodeURIComponent(filename)}`),
  saveAgentConfig: (filename: string, content: string) => request("/agents", { method: "POST", body: JSON.stringify({ filename, content }) }),
  deleteAgentConfig: (filename: string) => request(`/agents/${encodeURIComponent(filename)}`, { method: "DELETE" }),
  parseAgentYaml: (content: string) => request("/agents/parse", { method: "POST", body: JSON.stringify({ content }) }),
  generateAgentYaml: (data: any) => request("/agents/generate", { method: "POST", body: JSON.stringify(data) }),
  validateModel: (model: string) => request("/agents/validate-model", { method: "POST", body: JSON.stringify({ model }) }),
  generateAgentDefinition: (description: string) => request("/agents/generate-definition", { method: "POST", body: JSON.stringify({ description }) }),
  generateAgentSystem: (description: string, architectureType?: string, agentCount?: string) =>
    request("/agents/generate-system", { method: "POST", body: JSON.stringify({ description, architectureType, agentCount }) }),
};
