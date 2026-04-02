import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

const AgentEditor = lazy(() => import("../components/AgentEditor"));

interface McpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
}

interface FileToken {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatus[]>([]);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpJson, setMcpJson] = useState("");
  const [mcpJsonError, setMcpJsonError] = useState("");
  const [mcpJsonDirty, setMcpJsonDirty] = useState(false);
  const [fileTokens, setFileTokens] = useState<FileToken[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [showTokenId, setShowTokenId] = useState<string | null>(null);
  const [showAgentEditor, setShowAgentEditor] = useState(false);
  const [agentConfigs, setAgentConfigs] = useState<any[]>([]);
  const [agentEditorInitYaml, setAgentEditorInitYaml] = useState<string | undefined>();
  const [agentEditorInitFilename, setAgentEditorInitFilename] = useState<string | undefined>();
  const [uploadError, setUploadError] = useState("");
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderUrl, setNewProviderUrl] = useState("");
  const [newProviderModel, setNewProviderModel] = useState("");
  const [_oauthStatus, _setOauthStatus] = useState<{ message: string; success: boolean } | null>(null); // reserved for future use
  const yamlUploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
    api.getFileTokens().then(setFileTokens).catch(() => {});
    api.getAgentConfigs().then(setAgentConfigs).catch(() => {});
  }, []);

  const handleYamlUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError("");
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.match(/\.ya?ml$/i)) {
      setUploadError("Only .yaml or .yml files are accepted");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      if (!content) return;
      try {
        const baseName = file.name.replace(/\.ya?ml$/i, "");
        await api.saveAgentConfig(baseName, content);
        const configs = await api.getAgentConfigs();
        setAgentConfigs(configs);
      } catch (err: any) {
        setUploadError(err.message || "Upload failed — check YAML syntax");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const save = async () => {
    await api.saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const testConnection = async () => {
    setTestResult(null);
    const result = await api.testConnection({
      apiKey: settings.tigerBotApiKey,
      apiUrl: settings.tigerBotApiUrl,
      model: settings.tigerBotModel,
      provider: settings.aiProvider,
    });
    setTestResult(result);
  };

  // Convert mcpTools array to JSON display format
  const mcpToolsToJson = (tools: any[]): string => {
    if (!tools || tools.length === 0) {
      return JSON.stringify({ mcpServers: {} }, null, 2);
    }
    const servers: Record<string, any> = {};
    for (const t of tools) {
      const entry: any = {};
      if (t.type && t.type !== "auto") entry.type = t.type;
      if (t.url) entry.url = t.url;
      if (t.headers && Object.keys(t.headers).length > 0) entry.headers = t.headers;
      if (t.enabled === false) entry.enabled = false;
      servers[t.name] = entry;
    }
    return JSON.stringify({ mcpServers: servers }, null, 2);
  };

  // Convert JSON back to mcpTools array
  const jsonToMcpTools = (json: string): any[] | null => {
    try {
      const parsed = JSON.parse(json);
      const servers = parsed.mcpServers || parsed;
      if (typeof servers !== "object" || Array.isArray(servers)) return null;
      const tools: any[] = [];
      for (const [name, cfg] of Object.entries(servers)) {
        const c = cfg as any;
        tools.push({
          name,
          url: c.url || "",
          enabled: c.enabled !== false,
          type: c.type || "auto",
          ...(c.headers && Object.keys(c.headers).length > 0 ? { headers: c.headers } : {}),
        });
      }
      return tools;
    } catch {
      return null;
    }
  };

  // Sync mcpJson when settings.mcpTools changes externally (initial load)
  useEffect(() => {
    if (!mcpJsonDirty && settings.mcpTools !== undefined) {
      setMcpJson(mcpToolsToJson(settings.mcpTools || []));
    }
  }, [settings.mcpTools]);

  const applyMcpJson = () => {
    const tools = jsonToMcpTools(mcpJson);
    if (!tools) {
      setMcpJsonError("Invalid JSON format. Expected: { \"mcpServers\": { \"name\": { \"url\": \"...\", ... } } }");
      return;
    }
    setMcpJsonError("");
    setMcpJsonDirty(false);
    setSettings((prev: any) => ({ ...prev, mcpTools: tools }));
  };

  const reconnectAll = async () => {
    // Apply JSON first if dirty
    if (mcpJsonDirty) {
      const tools = jsonToMcpTools(mcpJson);
      if (!tools) {
        setMcpJsonError("Invalid JSON — fix before connecting");
        return;
      }
      setMcpJsonError("");
      setMcpJsonDirty(false);
      settings.mcpTools = tools;
    }
    setMcpConnecting("__all__");
    await api.saveSettings(settings);
    const result = await api.mcpReconnectAll();
    setMcpStatuses(result.status || []);
    setMcpConnecting(null);
  };

  const createFileToken = async () => {
    const token = await api.createFileToken(newTokenName || `Token ${fileTokens.length + 1}`);
    setFileTokens([...fileTokens, token]);
    setNewTokenName("");
  };

  const deleteFileToken = async (id: string) => {
    if (!confirm("Delete this file access token? Any links using it will stop working.")) return;
    await api.deleteFileToken(id);
    setFileTokens(fileTokens.filter((t) => t.id !== id));
  };

  const regenerateFileToken = async (id: string) => {
    if (!confirm("Regenerate this token? The old token will stop working immediately.")) return;
    const updated = await api.regenerateFileToken(id);
    setFileTokens(fileTokens.map((t) => (t.id === id ? updated : t)));
  };

  const copyToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 2000);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <button className={`btn btn-primary ${saved ? "btn-success" : ""}`} onClick={save}>
          {saved ? "Saved!" : "Save changes"}
        </button>
      </div>

      <div className="settings-grid">
        <section className="card">
          <h3>AI Provider</h3>
          <div className="form-group">
            <label>Provider</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                style={{ flex: 1 }}
                value={settings.aiProvider || "openrouter"}
                onChange={(e) => {
                  const newProvider = e.target.value;
                  const oldProvider = settings.aiProvider || "openrouter";
                  // Save current provider's settings before switching
                  const s: any = { ...settings };
                  s[`provider_${oldProvider}_apiKey`] = settings.tigerBotApiKey || "";
                  s[`provider_${oldProvider}_apiUrl`] = settings.tigerBotApiUrl || "";
                  s[`provider_${oldProvider}_model`] = settings.tigerBotModel || "";
                  // Restore new provider's saved settings or defaults
                  const builtinDefaults: Record<string, { url: string; model: string }> = {
                    openrouter: { url: "https://openrouter.ai/api/v1", model: "x-ai/grok-4.20-beta" },
                    zai: { url: "https://api.z.ai/api/coding/paas/v4", model: "GLM-5.1" },
                    anthropic_claude_code: { url: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514" },
                    minimax: { url: "https://api.minimax.io/v1", model: "MiniMax-M2.7" },
                    google_ai_studio: { url: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3-flash-preview" },
                  };
                  // Check custom providers for defaults
                  const customProviders: Array<{ id: string; name: string; url: string; model: string }> = settings.customProviders || [];
                  const customMatch = customProviders.find((p: any) => p.id === newProvider);
                  const d = builtinDefaults[newProvider] || (customMatch ? { url: customMatch.url, model: customMatch.model } : { url: "", model: "" });
                  s.tigerBotApiKey = s[`provider_${newProvider}_apiKey`] || "";
                  s.tigerBotApiUrl = s[`provider_${newProvider}_apiUrl`] || d.url;
                  s.tigerBotModel = s[`provider_${newProvider}_model`] || d.model;
                  s.aiProvider = newProvider;
                  setSettings(s);
                }}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="zai">zAi</option>
                <option value="anthropic_claude_code">Anthropic (Claude)</option>
                <option value="minimax">MiniMax</option>
                <option value="google_ai_studio">Google AI Studio</option>
                {(settings.customProviders || []).map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button className="btn btn-secondary" style={{ whiteSpace: "nowrap" }} onClick={() => setShowAddProvider(true)}>+ Add</button>
              {/* Show remove button only for custom providers */}
              {!(["openrouter", "zai", "anthropic_claude_code", "minimax", "google_ai_studio"].includes(settings.aiProvider || "openrouter")) && (
                <button className="btn btn-danger" style={{ whiteSpace: "nowrap" }} onClick={() => {
                  if (!confirm(`Remove provider "${(settings.customProviders || []).find((p: any) => p.id === settings.aiProvider)?.name || settings.aiProvider}"?`)) return;
                  const customProviders = (settings.customProviders || []).filter((p: any) => p.id !== settings.aiProvider);
                  // Switch back to openrouter
                  const s: any = { ...settings, customProviders, aiProvider: "openrouter" };
                  const d = { url: "https://openrouter.ai/api/v1", model: "x-ai/grok-4.20-beta" };
                  s.tigerBotApiKey = s.provider_openrouter_apiKey || "";
                  s.tigerBotApiUrl = s.provider_openrouter_apiUrl || d.url;
                  s.tigerBotModel = s.provider_openrouter_model || d.model;
                  setSettings(s);
                }}>Remove</button>
              )}
            </div>
            <p className="hint">Switch between AI providers. Each provider keeps its own API key, URL, and model.</p>
          </div>
          {showAddProvider && (
            <div style={{ background: "var(--bg-secondary, #1a1a2e)", borderRadius: 8, padding: 16, marginBottom: 16, border: "1px solid var(--border, #333)" }}>
              <h4 style={{ margin: "0 0 12px 0", fontSize: 14 }}>Add New Provider</h4>
              <div className="form-group">
                <label>Name</label>
                <input value={newProviderName} onChange={(e) => setNewProviderName(e.target.value)} placeholder="e.g. Anthropic, OpenAI, Groq, Gemini" />
              </div>
              <div className="form-group">
                <label>API URL (OpenAI-compatible)</label>
                <input value={newProviderUrl} onChange={(e) => setNewProviderUrl(e.target.value)} placeholder="e.g. https://api.openai.com/v1" />
              </div>
              <div className="form-group">
                <label>Default Model</label>
                <input value={newProviderModel} onChange={(e) => setNewProviderModel(e.target.value)} placeholder="e.g. gpt-4o, claude-3-opus" />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary" onClick={() => {
                  if (!newProviderName.trim()) return;
                  const id = newProviderName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
                  const customProviders = [...(settings.customProviders || [])];
                  if (customProviders.some((p: any) => p.id === id) || ["openrouter", "zai", "anthropic_claude_code"].includes(id)) return;
                  customProviders.push({ id, name: newProviderName.trim(), url: newProviderUrl.trim(), model: newProviderModel.trim() });
                  // Switch to the new provider immediately
                  const s: any = { ...settings, customProviders };
                  // Save current provider settings
                  const oldProvider = settings.aiProvider || "openrouter";
                  s[`provider_${oldProvider}_apiKey`] = settings.tigerBotApiKey || "";
                  s[`provider_${oldProvider}_apiUrl`] = settings.tigerBotApiUrl || "";
                  s[`provider_${oldProvider}_model`] = settings.tigerBotModel || "";
                  // Set new provider as active
                  s.aiProvider = id;
                  s.tigerBotApiKey = "";
                  s.tigerBotApiUrl = newProviderUrl.trim();
                  s.tigerBotModel = newProviderModel.trim();
                  setSettings(s);
                  setNewProviderName("");
                  setNewProviderUrl("");
                  setNewProviderModel("");
                  setShowAddProvider(false);
                }}>Add Provider</button>
                <button className="btn btn-secondary" onClick={() => { setShowAddProvider(false); setNewProviderName(""); setNewProviderUrl(""); setNewProviderModel(""); }}>Cancel</button>
              </div>
            </div>
          )}
          {settings.aiProvider === "anthropic_claude_code" && (
            <div style={{ background: "var(--bg-secondary, #1a1a2e)", borderRadius: 8, padding: 16, marginBottom: 16, border: "1px solid var(--border, #333)" }}>
              <h4 style={{ margin: "0 0 12px 0", fontSize: 14 }}>Setup Anthropic Claude</h4>

              {/* API Key method */}
              <div style={{ background: "var(--bg-primary, #0f0f23)", borderRadius: 6, padding: 12, border: "1px solid var(--border, #333)" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Get your API Key</div>
                <ol style={{ margin: "0 0 8px 0", paddingLeft: 20, fontSize: 13, opacity: 0.85, lineHeight: 1.7 }}>
                  <li>Click the button below to open Anthropic Console</li>
                  <li>Sign up or log in to your Anthropic account</li>
                  <li>Go to "API Keys" and click "Create Key"</li>
                  <li>Copy the key (starts with <code style={{ fontSize: 12 }}>sk-ant-api03-</code>)</li>
                  <li>Paste it in the API Key field below, then click Save</li>
                </ol>
                <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => {
                  window.open("https://console.anthropic.com/settings/keys", "_blank");
                }}>Open Anthropic Console</button>
                <p className="hint" style={{ fontSize: 12, margin: "8px 0 0 0", opacity: 0.7 }}>
                  Pay-per-token billing. Requires adding credits to your Anthropic account.
                </p>
              </div>

              <p className="hint" style={{ fontSize: 11, margin: "10px 0 0 0", opacity: 0.5 }}>
                Note: Claude subscription OAuth tokens (sk-ant-oat01-...) are restricted to Claude Code only and cannot be used for direct API access. Use an API key instead.
              </p>
            </div>
          )}
          <div className="form-group">
            <label>API Key</label>
            <input type="password" value={settings.tigerBotApiKey || ""} onChange={(e) => setSettings({ ...settings, tigerBotApiKey: e.target.value })} placeholder={settings.aiProvider === "anthropic_claude_code" ? "Paste your Anthropic API key (sk-ant-api03-...)" : "Enter your API key"} />
            {settings.aiProvider === "anthropic_claude_code" && settings.tigerBotApiKey && !settings.tigerBotApiKey.includes("...") && (
              <p className="hint" style={{ marginTop: 4, fontSize: 12, color: settings.tigerBotApiKey.startsWith("sk-ant-oat01-") ? "var(--error, #f44336)" : settings.tigerBotApiKey.startsWith("sk-ant-api") ? "var(--success, #4caf50)" : "inherit" }}>
                {settings.tigerBotApiKey.startsWith("sk-ant-oat01-") ? "OAuth token detected — this will NOT work. Please use an API key (sk-ant-api03-...) from the Anthropic Console instead." :
                 settings.tigerBotApiKey.startsWith("sk-ant-api") ? "API key detected" :
                 "Key format not recognized, but will try"}
              </p>
            )}
          </div>
          <div className="form-group">
            <label>API URL</label>
            <input value={settings.tigerBotApiUrl || ""} onChange={(e) => setSettings({ ...settings, tigerBotApiUrl: e.target.value })} placeholder="OpenAI-compatible API endpoint" />
          </div>
          <div className="form-group">
            <label>Model</label>
            <input value={settings.tigerBotModel || ""} onChange={(e) => setSettings({ ...settings, tigerBotModel: e.target.value })} placeholder="Model name" />
          </div>
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={testConnection}>Test Connection</button>
            {testResult && (
              <span className={`test-result ${testResult.success ? "success" : "error"}`}>
                {testResult.message}
              </span>
            )}
          </div>
        </section>

        <section className="card">
          <h3>Sandbox</h3>
          <div className="form-group">
            <label>Sandbox Directory</label>
            <input value={settings.sandboxDir || ""} onChange={(e) => setSettings({ ...settings, sandboxDir: e.target.value })} />
            <p className="hint">All file operations are restricted to this directory</p>
          </div>
          <div className="form-group">
            <label>Python Path</label>
            <input value={settings.pythonPath || ""} onChange={(e) => setSettings({ ...settings, pythonPath: e.target.value })} placeholder="python3" />
          </div>
        </section>

        <section className="card">
          <h3>Web Search</h3>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.webSearchEnabled || false} onChange={(e) => setSettings({ ...settings, webSearchEnabled: e.target.checked })} />
              <span>Enable web search</span>
            </label>
          </div>
          <div className="form-group">
            <label>Search Engine</label>
            <select value={settings.webSearchEngine || "duckduckgo"} onChange={(e) => setSettings({ ...settings, webSearchEngine: e.target.value })}>
              <option value="duckduckgo">DuckDuckGo (free)</option>
              <option value="google">Google Custom Search</option>
            </select>
          </div>
          {settings.webSearchEngine === "google" && (
            <>
              <div className="form-group">
                <label>Google API Key</label>
                <input type="password" value={settings.webSearchApiKey || ""} onChange={(e) => setSettings({ ...settings, webSearchApiKey: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Google Search CX</label>
                <input value={settings.googleSearchCx || ""} onChange={(e) => setSettings({ ...settings, googleSearchCx: e.target.value })} />
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>OpenRouter Web Search</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Use OpenRouter's Responses API as a web search tool for the agent. Requires an OpenRouter API key.
          </p>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.openRouterSearchEnabled || false} onChange={(e) => setSettings({ ...settings, openRouterSearchEnabled: e.target.checked })} />
              <span>Enable OpenRouter Web Search</span>
            </label>
          </div>
          {settings.openRouterSearchEnabled && (
            <>
              <div className="form-group">
                <label>API Key</label>
                <input type="password" value={settings.openRouterSearchApiKey || ""} onChange={(e) => setSettings({ ...settings, openRouterSearchApiKey: e.target.value })} placeholder="sk-or-v1-..." />
              </div>
              <div className="form-group">
                <label>Model</label>
                <input value={settings.openRouterSearchModel || ""} onChange={(e) => setSettings({ ...settings, openRouterSearchModel: e.target.value })} placeholder="openai/gpt-4.1-mini (default)" />
                <p className="hint">OpenRouter model to use for web search. Must support the web search plugin.</p>
              </div>
              <div className="form-group">
                <label>Max Output Tokens</label>
                <input type="number" value={settings.openRouterSearchMaxTokens || 4096} onChange={(e) => setSettings({ ...settings, openRouterSearchMaxTokens: parseInt(e.target.value) || 4096 })} min={100} max={32000} />
              </div>
              <div className="form-group">
                <label>Max Search Results (1-10)</label>
                <input type="number" value={settings.openRouterSearchMaxResults || 5} onChange={(e) => setSettings({ ...settings, openRouterSearchMaxResults: Math.min(10, Math.max(1, parseInt(e.target.value) || 5)) })} min={1} max={10} />
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>Agent Parameters</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Controls how many tool calls and rounds the AI agent can use per conversation turn. Increase for complex research tasks.
          </p>
          <div className="form-group">
            <label>Max Tool Rounds</label>
            <input type="number" value={settings.agentMaxToolRounds || 8} onChange={(e) => setSettings({ ...settings, agentMaxToolRounds: Math.max(1, parseInt(e.target.value) || 8) })} min={1} max={50} />
            <p className="hint">Maximum iterations of the tool-calling loop (default: 8)</p>
          </div>
          <div className="form-group">
            <label>Max Tool Calls</label>
            <input type="number" value={settings.agentMaxToolCalls || 12} onChange={(e) => setSettings({ ...settings, agentMaxToolCalls: Math.max(1, parseInt(e.target.value) || 12) })} min={1} max={100} />
            <p className="hint">Maximum total tool calls per turn (default: 12)</p>
          </div>
          <div className="form-group">
            <label>Max Consecutive Errors</label>
            <input type="number" value={settings.agentMaxConsecutiveErrors || 3} onChange={(e) => setSettings({ ...settings, agentMaxConsecutiveErrors: Math.max(1, parseInt(e.target.value) || 3) })} min={1} max={20} />
            <p className="hint">Stop after this many consecutive tool failures (default: 3)</p>
          </div>
          <div className="form-group">
            <label>Tool Result Max Length</label>
            <input type="number" value={settings.agentToolResultMaxLen || 6000} onChange={(e) => setSettings({ ...settings, agentToolResultMaxLen: Math.max(1000, parseInt(e.target.value) || 6000) })} min={1000} max={50000} step={1000} />
            <p className="hint">Max characters per tool result before truncation (default: 6000)</p>
          </div>
          <div className="form-group">
            <label>Temperature</label>
            <input type="number" value={settings.agentTemperature ?? 0.7} onChange={(e) => setSettings({ ...settings, agentTemperature: Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)) })} min={0} max={2} step={0.1} />
            <p className="hint">LLM temperature (0 = deterministic, 2 = very creative, default: 0.7)</p>
          </div>
          <div className="form-group">
            <label>Context Compression Interval</label>
            <input type="number" value={settings.agentCompressionInterval || 5} onChange={(e) => setSettings({ ...settings, agentCompressionInterval: Math.max(1, parseInt(e.target.value) || 5) })} min={1} max={20} />
            <p className="hint">Compress older messages every N tool rounds during agent runs (default: 5)</p>
          </div>
          <div className="form-group">
            <label>Compression Window Size</label>
            <input type="number" value={settings.agentCompressionWindowSize || 10} onChange={(e) => setSettings({ ...settings, agentCompressionWindowSize: Math.max(4, parseInt(e.target.value) || 10) })} min={4} max={30} />
            <p className="hint">Number of recent messages to keep uncompressed (default: 10)</p>
          </div>
          <div className="form-group">
            <label>Max Context Tokens</label>
            <input type="number" value={settings.agentMaxContextTokens || 100000} onChange={(e) => setSettings({ ...settings, agentMaxContextTokens: Math.max(10000, parseInt(e.target.value) || 100000) })} min={10000} max={2000000} step={10000} />
            <p className="hint">Auto-compact context when estimated tokens exceed this limit (default: 100,000)</p>
          </div>
        </section>

        <section className="card">
          <h3>Sub-Agent</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Allow the AI to spawn independent sub-agents for complex tasks. Sub-agents run their own tool-calling loop and return results to the parent agent. Useful for parallel research, multi-step analysis, or breaking down large tasks.
          </p>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.subAgentEnabled || false} onChange={(e) => setSettings({ ...settings, subAgentEnabled: e.target.checked })} />
              <span>Enable Sub-Agent Spawning</span>
            </label>
          </div>
          {settings.subAgentEnabled && (
            <>
              {/* Sub-Agent Mode Selection */}
              <div className="form-group">
                <label>Sub-Agent Mode</label>
                <select
                  value={settings.subAgentMode || "auto"}
                  onChange={(e) => setSettings({ ...settings, subAgentMode: e.target.value })}
                >
                  <option value="auto">Auto (AI decides)</option>
                  <option value="manual">Spawn Agent (YAML config file)</option>
                  <option value="realtime">Realtime Agent (YAML config file)</option>
                </select>
                <p className="hint">
                  {settings.subAgentMode === "realtime"
                    ? "All agents boot at session start and stay alive — tasks are sent via bus for true parallel execution"
                    : settings.subAgentMode === "manual"
                    ? "Agents are defined by a YAML configuration file you provide"
                    : "The AI automatically spawns and manages sub-agents as needed"}
                </p>
              </div>

              {(settings.subAgentMode === "manual" || settings.subAgentMode === "realtime") ? (
                <>
                  {/* Manual YAML Config */}
                  <div className="form-group">
                    <label>Agent Configuration File</label>
                    <select
                      value={settings.subAgentConfigFile || ""}
                      onChange={(e) => setSettings({ ...settings, subAgentConfigFile: e.target.value })}
                    >
                      <option value="">Select a config file...</option>
                      {agentConfigs.map((cfg: any) => (
                        <option key={cfg.filename} value={cfg.filename}>
                          {cfg.name} ({cfg.filename}) — {cfg.agentCount} agents
                        </option>
                      ))}
                    </select>
                    <p className="hint">
                      Select a YAML file that defines your agent team. Create one below or place .yaml files in data/agents/
                    </p>
                  </div>

                  {/* Saved configs list */}
                  {agentConfigs.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>
                        Saved Configurations
                      </label>
                      {agentConfigs.map((cfg: any) => (
                        <div key={cfg.filename} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13
                        }}>
                          <span style={{ flex: 1 }}>
                            <strong>{cfg.name}</strong>
                            <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 11 }}>{cfg.filename}</span>
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{cfg.agentCount} agents</span>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={async () => {
                              const data = await api.getAgentConfig(cfg.filename);
                              if (data.content) {
                                setAgentEditorInitYaml(data.content);
                                setAgentEditorInitFilename(cfg.filename);
                                setShowAgentEditor(true);
                              }
                            }}
                          >Edit</button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={async () => {
                              if (confirm(`Delete ${cfg.filename}?`)) {
                                await api.deleteAgentConfig(cfg.filename);
                                setAgentConfigs(agentConfigs.filter((c: any) => c.filename !== cfg.filename));
                                if (settings.subAgentConfigFile === cfg.filename) {
                                  setSettings({ ...settings, subAgentConfigFile: "" });
                                }
                              }
                            }}
                          >Delete</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Create / Upload Agent Config */}
                  <div className="form-actions" style={{ gap: 8, flexWrap: "wrap" }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => { setAgentEditorInitYaml(undefined); setAgentEditorInitFilename(undefined); setShowAgentEditor(true); }}
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                      </svg>
                      Swarm Agent Creator
                    </button>
                    <input
                      ref={yamlUploadRef}
                      type="file"
                      accept=".yaml,.yml"
                      style={{ display: "none" }}
                      onChange={handleYamlUpload}
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={() => yamlUploadRef.current?.click()}
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
                      </svg>
                      Upload YAML
                    </button>
                    {uploadError && (
                      <p style={{ width: "100%", margin: 0, color: "#ea4335", fontSize: 12 }}>{uploadError}</p>
                    )}
                    <p className="hint" style={{ width: "100%", margin: 0 }}>
                      Design agents visually with the Swarm Creator, or upload an existing .yaml architecture file.
                    </p>
                  </div>

                  {/* Sub-Agent Parameters for manual/realtime mode */}
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                    <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: "block" }}>Sub-Agent Parameters</label>
                    <p className="hint" style={{ marginBottom: 12 }}>
                      Controls timeout, error recovery, and context management for each agent in the swarm.
                    </p>
                    <div className="form-group">
                      <label>Agent Timeout (seconds)</label>
                      <input type="number" value={settings.subAgentTimeout ?? 600} onChange={(e) => setSettings({ ...settings, subAgentTimeout: Math.min(1800, Math.max(30, parseInt(e.target.value) || 600)) })} min={30} max={1800} step={30} />
                      <p className="hint">Max time to wait for each agent to complete a task before timeout (default: 600s). Increase for complex multi-step tasks.</p>
                    </div>
                    <div className="form-group">
                      <label>Max Error Recoveries</label>
                      <input type="number" value={settings.agentMaxErrorRecoveries ?? 5} onChange={(e) => setSettings({ ...settings, agentMaxErrorRecoveries: Math.min(20, Math.max(1, parseInt(e.target.value) || 5)) })} min={1} max={20} />
                      <p className="hint">How many times agents attempt self-recovery after consecutive errors before stopping (default: 5)</p>
                    </div>
                    <div className="form-group">
                      <label>Context Compression Interval</label>
                      <input type="number" value={settings.agentCompressionInterval || 5} onChange={(e) => setSettings({ ...settings, agentCompressionInterval: Math.max(1, parseInt(e.target.value) || 5) })} min={1} max={30} />
                      <p className="hint">Compress older agent messages every N tool rounds to save context (default: 5)</p>
                    </div>
                    <div className="form-group">
                      <label>Checkpoint Interval</label>
                      <input type="number" value={settings.agentCheckpointInterval || 5} onChange={(e) => setSettings({ ...settings, agentCheckpointInterval: Math.max(1, parseInt(e.target.value) || 5) })} min={1} max={30} />
                      <p className="hint">Auto-save agent progress every N rounds for crash recovery (default: 5)</p>
                    </div>
                    <div className="form-group">
                      <label className="toggle-label">
                        <input type="checkbox" checked={settings.agentCheckpointEnabled !== false} onChange={(e) => setSettings({ ...settings, agentCheckpointEnabled: e.target.checked })} />
                        <span>Enable Checkpoints</span>
                      </label>
                      <p className="hint">Save agent state periodically so tasks can resume after interruption</p>
                    </div>
                    <div className="form-group">
                      <label>Max Context Tokens</label>
                      <input type="number" value={settings.agentMaxContextTokens || 100000} onChange={(e) => setSettings({ ...settings, agentMaxContextTokens: Math.max(10000, parseInt(e.target.value) || 100000) })} min={10000} max={2000000} step={10000} />
                      <p className="hint">Auto-compact context when estimated tokens exceed this limit (default: 100,000)</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group">
                    <label>Sub-Agent Model (optional)</label>
                    <input value={settings.subAgentModel || ""} onChange={(e) => setSettings({ ...settings, subAgentModel: e.target.value })} placeholder="Leave empty to use main model" />
                    <p className="hint">Override the LLM model for sub-agents (e.g. use a smaller/cheaper model)</p>
                  </div>
                  <div className="form-group">
                    <label>Max Depth</label>
                    <input type="number" value={settings.subAgentMaxDepth ?? 2} onChange={(e) => setSettings({ ...settings, subAgentMaxDepth: Math.min(5, Math.max(1, parseInt(e.target.value) || 2)) })} min={1} max={5} />
                    <p className="hint">How many levels deep sub-agents can spawn other sub-agents (default: 2, max: 5)</p>
                  </div>
                  <div className="form-group">
                    <label>Max Concurrent Sub-Agents</label>
                    <input type="number" value={settings.subAgentMaxConcurrent ?? 3} onChange={(e) => setSettings({ ...settings, subAgentMaxConcurrent: Math.min(10, Math.max(1, parseInt(e.target.value) || 3)) })} min={1} max={10} />
                    <p className="hint">Maximum sub-agents running at the same time (default: 3)</p>
                  </div>
                  <div className="form-group">
                    <label>Timeout (seconds)</label>
                    <input type="number" value={settings.subAgentTimeout ?? 120} onChange={(e) => setSettings({ ...settings, subAgentTimeout: Math.min(1800, Math.max(30, parseInt(e.target.value) || 120)) })} min={30} max={1800} step={10} />
                    <p className="hint">Max time per sub-agent before timeout (default: 120s, max: 1800s)</p>
                  </div>
                  <div className="form-group">
                    <label>Max Error Recoveries</label>
                    <input type="number" value={settings.agentMaxErrorRecoveries ?? 5} onChange={(e) => setSettings({ ...settings, agentMaxErrorRecoveries: Math.min(20, Math.max(1, parseInt(e.target.value) || 5)) })} min={1} max={20} />
                    <p className="hint">How many self-recovery attempts before giving up (default: 5)</p>
                  </div>
                </>
              )}
            </>
          )}
        </section>

        <section className="card">
          <h3>Reflection Loop Check</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            After the agent finishes, evaluate if the result satisfies the objective. If the score is below the threshold, the agent retries to address gaps. Disable to save tokens.
          </p>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.agentReflectionEnabled || false} onChange={(e) => setSettings({ ...settings, agentReflectionEnabled: e.target.checked })} />
              <span>Enable Reflection Loop</span>
            </label>
          </div>
          {settings.agentReflectionEnabled && (
            <>
              <div className="form-group">
                <label>Evaluation Score Threshold</label>
                <input type="number" value={settings.agentEvalThreshold ?? 0.7} onChange={(e) => setSettings({ ...settings, agentEvalThreshold: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0.7)) })} min={0} max={1} step={0.05} />
                <p className="hint">Minimum score (0.0–1.0) to consider objective satisfied (default: 0.7)</p>
              </div>
              <div className="form-group">
                <label>Max Reflection Retries</label>
                <input type="number" value={settings.agentMaxReflectionRetries ?? 2} onChange={(e) => setSettings({ ...settings, agentMaxReflectionRetries: Math.min(5, Math.max(1, parseInt(e.target.value) || 2)) })} min={1} max={5} />
                <p className="hint">How many times to re-evaluate and retry (default: 2, max: 5)</p>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>File Access Tokens</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Tokens protect sandbox file access. Without a valid token, external users cannot view or download files via the port.
            Share a token only with people you want to grant file access.
          </p>

          {fileTokens.map((ft) => (
            <div key={ft.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ flex: 1 }}>
                <strong>{ft.name}</strong>
                <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 2, color: "var(--text-muted)" }}>
                  {showTokenId === ft.id ? ft.token : ft.token.slice(0, 8) + "••••••••" + ft.token.slice(-4)}
                </div>
                <div style={{ fontSize: 11, opacity: 0.5 }}>
                  Created: {new Date(ft.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowTokenId(showTokenId === ft.id ? null : ft.id)}
                title={showTokenId === ft.id ? "Hide" : "Show"}
              >
                {showTokenId === ft.id ? "Hide" : "Show"}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => copyToken(ft.id, ft.token)}
              >
                {copiedTokenId === ft.id ? "Copied!" : "Copy"}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => regenerateFileToken(ft.id)}
              >
                Regenerate
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => deleteFileToken(ft.id)}
              >
                Delete
              </button>
            </div>
          ))}

          {fileTokens.length === 0 && (
            <div style={{ padding: "12px 0", opacity: 0.6 }}>No file tokens yet. Create one to secure file access.</div>
          )}

          <div className="inline-form" style={{ marginTop: 8 }}>
            <input
              placeholder="Token name (e.g. Team, Public)"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFileToken()}
            />
            <button className="btn btn-primary" onClick={createFileToken}>Create Token</button>
          </div>
        </section>

        <section className="card">
          <h3>MCP Servers</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Configure MCP servers as JSON. Supports type: "http", "sse", "stdio" (default: auto-detect). Add custom headers for authentication.
          </p>

          <textarea
            value={mcpJson}
            onChange={(e) => { setMcpJson(e.target.value); setMcpJsonDirty(true); setMcpJsonError(""); }}
            spellCheck={false}
            style={{
              width: "100%", minHeight: 200, fontFamily: "monospace", fontSize: 13,
              padding: 12, borderRadius: 6, border: `1px solid ${mcpJsonError ? "#ea4335" : "var(--border)"}`,
              background: "var(--bg-secondary, #1e1e1e)", color: "var(--text-primary, #d4d4d4)",
              resize: "vertical", lineHeight: 1.5, tabSize: 2,
            }}
            placeholder={`{
  "mcpServers": {
    "web-search-prime": {
      "type": "http",
      "url": "https://api.z.ai/api/mcp/web_search_prime/mcp",
      "headers": {
        "Authorization": "Bearer your_api_key"
      }
    }
  }
}`}
          />
          {mcpJsonError && (
            <p style={{ color: "#ea4335", fontSize: 12, margin: "4px 0 0" }}>{mcpJsonError}</p>
          )}
          {mcpJsonDirty && (
            <p style={{ color: "#f9ab00", fontSize: 12, margin: "4px 0 0" }}>Unsaved JSON changes — click "Apply" or "Save & Connect All"</p>
          )}

          <div className="form-actions" style={{ marginTop: 10, gap: 8 }}>
            <button
              className="btn btn-secondary"
              onClick={applyMcpJson}
              disabled={!mcpJsonDirty}
            >
              Apply
            </button>
            <button
              className="btn btn-primary"
              onClick={reconnectAll}
              disabled={mcpConnecting === "__all__"}
            >
              {mcpConnecting === "__all__" ? "Connecting..." : "Save & Connect All"}
            </button>
          </div>

          {/* Connection Status */}
          {mcpStatuses.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: "block" }}>Connection Status</label>
              {mcpStatuses.map((s) => (
                <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: s.connected ? "#34a853" : "#ea4335",
                    display: "inline-block", flexShrink: 0,
                  }} />
                  <strong style={{ flex: 1 }}>{s.name}</strong>
                  {s.connected ? (
                    <span style={{ fontSize: 11, color: "#137333" }}>{s.toolCount} tools</span>
                  ) : (
                    <span style={{ fontSize: 11, color: "#ea4335" }}>disconnected</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Discovered tools */}
          {mcpStatuses.some((s) => s.connected && s.toolCount > 0) && (
            <details style={{ marginTop: 8, fontSize: 13 }}>
              <summary style={{ cursor: "pointer", opacity: 0.7 }}>Discovered MCP Tools</summary>
              <div style={{ padding: "8px 0", maxHeight: 200, overflow: "auto" }}>
                {mcpStatuses.filter((s) => s.connected).map((s) => (
                  <div key={s.name} style={{ marginBottom: 8 }}>
                    <strong>{s.name}</strong>
                    <div style={{ paddingLeft: 12, opacity: 0.7 }}>
                      {s.tools.map((t) => <div key={t}>{t}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      </div>

      {/* Agent Editor Modal */}
      {showAgentEditor && (
        <Suspense fallback={<div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>Loading editor...</div>}>
          <AgentEditor
            onClose={() => { setShowAgentEditor(false); setAgentEditorInitYaml(undefined); setAgentEditorInitFilename(undefined); }}
            initialFilename={agentEditorInitFilename}
            onSave={async (savedFilename) => {
              setShowAgentEditor(false);
              setAgentEditorInitYaml(undefined);
              setAgentEditorInitFilename(undefined);
              // Refresh agent configs list
              const configs = await api.getAgentConfigs();
              setAgentConfigs(configs);
              // Auto-select the saved file
              setSettings({ ...settings, subAgentConfigFile: savedFilename });
            }}
            initialYaml={agentEditorInitYaml}
          />
        </Suspense>
      )}
    </div>
  );
}
