import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../utils/api";
import "./AgentEditor.css";

// ─── Types ───

interface AgentNode {
  id: string;
  name: string;
  role: string;
  model: string;
  persona: string;
  responsibilities: string[];
  x: number;
  y: number;
  color: string;
  busEnabled: boolean;
  busTopics: string[];
  meshEnabled: boolean;
  p2pConfidenceDomains: string[];
  p2pReputationScore: number;
  p2pBidder: boolean;
}

interface P2PGovernance {
  consensus_mechanism: string;
  bid_timeout_seconds: number;
  vote_timeout_seconds: number;
  min_confidence_threshold: number;
  max_task_retries: number;
  audit_log: boolean;
}

interface Connection {
  id: string;
  from: string;
  to: string;
  label: string;
  protocol: string; // tcp_socket | queue | event_bus
  topics: string[];
}

interface EditorState {
  systemName: string;
  orchestrationMode: string;
  agents: AgentNode[];
  connections: Connection[];
  p2pGovernance: P2PGovernance;
}

const ROLE_COLORS: Record<string, string> = {
  human: "#e91e63",
  orchestrator: "#4285f4",
  worker: "#34a853",
  checker: "#ea8600",
  reporter: "#9c27b0",
  researcher: "#00bcd4",
  peer: "#ff9800",
  default: "#607d8b",
};

// No hardcoded model list — users type model names and validate against the backend

const ROLES = ["human", "orchestrator", "worker", "checker", "reporter", "researcher", "peer"];
const PROTOCOLS = ["tcp", "queue"];
const PROTOCOL_LABELS: Record<string, string> = {
  tcp: "TCP",
  queue: "Queue",
};

function generateId() {
  return "n_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

// ─── Agent Definition Panel ───

function AgentDefPanel({
  agent,
  onUpdate,
  onClose,
  onDelete,
  orchestrationMode,
}: {
  agent: AgentNode;
  onUpdate: (a: AgentNode) => void;
  onClose: () => void;
  onDelete: () => void;
  orchestrationMode: string;
}) {
  const [llmPrompt, setLlmPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [showModelInput, setShowModelInput] = useState(!!agent.model);
  const [modelValidating, setModelValidating] = useState(false);
  const [modelValid, setModelValid] = useState<boolean | null>(null);

  // Reset model UI state when switching to a different agent
  useEffect(() => {
    setShowModelInput(!!agent.model);
    setModelValid(null);
    setModelValidating(false);
  }, [agent.id]);

  const generateWithLLM = async () => {
    if (!llmPrompt.trim()) return;
    setGenerating(true);
    try {
      const result = await api.generateAgentDefinition(llmPrompt);
      if (result.ok && result.definition) {
        const parsed = result.definition;
        onUpdate({
          ...agent,
          name: parsed.name || agent.name,
          role: parsed.role || agent.role,
          model: agent.model,
          persona: parsed.persona || agent.persona,
          responsibilities: Array.isArray(parsed.responsibilities) ? parsed.responsibilities : agent.responsibilities,
          color: ROLE_COLORS[parsed.role] || agent.color,
        });
      } else {
        console.error("Agent generation failed:", result.error || result.raw);
      }
    } catch (err) {
      console.error("LLM generation failed:", err);
    }
    setGenerating(false);
  };

  return (
    <div className="agent-def-panel">
      <div className="agent-def-header">
        <h3>Agent Definition</h3>
        <button className="btn-icon btn-ghost" onClick={onClose}>&times;</button>
      </div>

      <div className="agent-def-body">
        {/* LLM Helper — not for human nodes */}
        {agent.role !== "human" && (
          <div className="agent-def-llm-section">
            <label>AI-Assisted Setup</label>
            <div className="agent-def-llm-row">
              <textarea
                placeholder="Describe the agent you want (e.g. 'A structural engineer who reviews calculations and checks code compliance')..."
                value={llmPrompt}
                onChange={(e) => setLlmPrompt(e.target.value)}
                rows={2}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={generateWithLLM}
                disabled={generating || !llmPrompt.trim()}
              >
                {generating ? "..." : "Generate"}
              </button>
            </div>
          </div>
        )}

        {agent.role !== "human" && <div className="agent-def-divider">or edit manually</div>}
        {agent.role === "human" && (
          <div className="human-node-info">
            <p>Human node — the entry point for user interaction. Connect this node to agents that the user can talk to directly via <code>/agent [name] "prompt"</code>.</p>
          </div>
        )}

        <div className="agent-def-form">
          <div className="form-group">
            <label>Agent ID</label>
            <input
              value={agent.id}
              onChange={(e) => onUpdate({ ...agent, id: e.target.value.replace(/[^a-z0-9_]/g, "") })}
              placeholder="e.g. design_engineer_1"
            />
          </div>
          <div className="form-group">
            <label>Name</label>
            <input
              value={agent.name}
              onChange={(e) => onUpdate({ ...agent, name: e.target.value })}
              placeholder={agent.role === "human" ? "e.g. User" : "e.g. Design Engineer 1"}
            />
          </div>
          <div className="form-group">
            <label>Role</label>
            <select
              value={agent.role}
              onChange={(e) => onUpdate({ ...agent, role: e.target.value, color: ROLE_COLORS[e.target.value] || agent.color })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          {/* Model, Persona, Responsibilities — hidden for human nodes */}
          {agent.role !== "human" && (
            <>
              <div className="form-group">
                <label className="model-checkbox-label">
                  <input
                    type="checkbox"
                    checked={showModelInput}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setShowModelInput(checked);
                      if (!checked) {
                        onUpdate({ ...agent, model: "" });
                        setModelValid(null);
                      }
                    }}
                  />
                  <span>Specify model for this agent</span>
                </label>
                {!showModelInput && (
                  <p className="model-hint">Using system default model</p>
                )}
                {showModelInput && (
                  <>
                    <div className="model-input-row">
                      <select
                        value={agent.model?.startsWith("claude-code") ? "claude-code" : agent.model?.startsWith("codex") ? "codex" : "__custom__"}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "claude-code" || val === "codex") {
                            onUpdate({ ...agent, model: val });
                            setModelValid(true);
                          } else {
                            if (agent.model?.startsWith("claude-code") || agent.model?.startsWith("codex")) {
                              onUpdate({ ...agent, model: "" });
                            }
                            setModelValid(null);
                          }
                        }}
                        style={{ width: "auto", minWidth: 160 }}
                      >
                        <option value="__custom__">API Model</option>
                        <option value="claude-code">Claude Code (Local CLI)</option>
                        <option value="codex">Codex (Local CLI)</option>
                      </select>
                      {agent.model?.startsWith("claude-code") && (
                        <input
                          value={agent.model.includes(":") ? agent.model.split(":").slice(1).join(":") : ""}
                          onChange={(e) => {
                            const sub = e.target.value.trim();
                            onUpdate({ ...agent, model: sub ? `claude-code:${sub}` : "claude-code" });
                          }}
                          placeholder="model (e.g. sonnet, opus) — blank = default"
                          style={{ flex: 1 }}
                        />
                      )}
                      {agent.model?.startsWith("codex") && (
                        <input
                          value={agent.model.includes(":") ? agent.model.split(":").slice(1).join(":") : ""}
                          onChange={(e) => {
                            const sub = e.target.value.trim();
                            onUpdate({ ...agent, model: sub ? `codex:${sub}` : "codex" });
                          }}
                          placeholder="model (e.g. o3, o4-mini, gpt-4.1) — blank = default"
                          style={{ flex: 1 }}
                        />
                      )}
                      {!agent.model?.startsWith("claude-code") && !agent.model?.startsWith("codex") && (
                        <>
                          <input
                            value={agent.model}
                            onChange={(e) => {
                              onUpdate({ ...agent, model: e.target.value });
                              setModelValid(null);
                            }}
                            placeholder="e.g. claude-opus-4-6, gpt-4o, gemini-pro"
                            style={{ flex: 1 }}
                          />
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={async () => {
                              setModelValidating(true);
                              try {
                                const res = await api.validateModel(agent.model);
                                setModelValid(res.available);
                              } catch {
                                setModelValid(false);
                              }
                              setModelValidating(false);
                            }}
                            disabled={modelValidating || !agent.model.trim()}
                          >
                            {modelValidating ? "..." : "Validate"}
                          </button>
                        </>
                      )}
                    </div>
                    {agent.model?.startsWith("claude-code") && (
                      <span className="model-valid-msg" style={{ display: "block", marginTop: 4 }}>
                        Uses locally installed Claude Code CLI — no API key needed (OAuth login)
                      </span>
                    )}
                    {agent.model?.startsWith("codex") && (
                      <span className="model-valid-msg" style={{ display: "block", marginTop: 4 }}>
                        Uses locally installed Codex CLI — requires ChatGPT Plus/Pro or CODEX_API_KEY
                      </span>
                    )}
                    {!agent.model?.startsWith("claude-code") && !agent.model?.startsWith("codex") && modelValid === true && (
                      <span className="model-valid-msg">Model available</span>
                    )}
                    {!agent.model?.startsWith("claude-code") && !agent.model?.startsWith("codex") && modelValid === false && (
                      <span className="model-invalid-msg">Model not found — you can still use it</span>
                    )}
                  </>
                )}
              </div>
              <div className="form-group">
                <label>Persona</label>
                <textarea
                  value={agent.persona}
                  onChange={(e) => onUpdate({ ...agent, persona: e.target.value })}
                  rows={4}
                  placeholder="Describe the agent's personality, expertise, and behavior..."
                />
              </div>
              <div className="form-group">
                <label>Responsibilities (one per line)</label>
                <textarea
                  value={agent.responsibilities.join("\n")}
                  onChange={(e) => onUpdate({ ...agent, responsibilities: e.target.value.split("\n").filter(Boolean) })}
                  rows={4}
                  placeholder="- Parse and interpret requirements&#10;- Assign tasks to sub-agents&#10;- Review outputs"
                />
              </div>
            </>
          )}

          {/* Bus Connection */}
          <div className="agent-def-divider">communication</div>
          <div className="form-group">
            <label className="bus-toggle-label">
              <input
                type="checkbox"
                checked={agent.busEnabled}
                onChange={(e) => onUpdate({ ...agent, busEnabled: e.target.checked })}
              />
              <span>Connected to Message Bus</span>
            </label>
            <p className="bus-hint">Shared broadcast channel — all bus-connected agents can see messages</p>
          </div>
          {agent.busEnabled && (
            <div className="form-group">
              <label>Bus Topics (one per line)</label>
              <textarea
                value={agent.busTopics.join("\n")}
                onChange={(e) => onUpdate({ ...agent, busTopics: e.target.value.split("\n").filter(Boolean) })}
                rows={3}
                placeholder="parameter_share&#10;clash_flag&#10;status_update"
              />
            </div>
          )}

          {/* Mesh — free to talk to any agent */}
          <div className="form-group">
            <label className="bus-toggle-label">
              <input
                type="checkbox"
                checked={agent.meshEnabled}
                onChange={(e) => onUpdate({ ...agent, meshEnabled: e.target.checked })}
              />
              <span>Mesh (free to talk)</span>
            </label>
            <p className="bus-hint">Can send tasks to any agent without needing connection lines</p>
          </div>

          {/* P2P Peer Configuration */}
          {agent.role === "peer" && (
            <>
              <div className="agent-def-divider">P2P peer config</div>
              <div className="form-group">
                <label>Confidence Domains (one per line)</label>
                <textarea
                  value={agent.p2pConfidenceDomains.join("\n")}
                  onChange={(e) => onUpdate({ ...agent, p2pConfidenceDomains: e.target.value.split("\n").filter(Boolean) })}
                  rows={3}
                  placeholder="data_analysis&#10;web_research&#10;code_review"
                />
                <p className="bus-hint">Domains this agent excels at — used for task bidding confidence</p>
              </div>
              <div className="form-group">
                <label>Reputation Score (0-1)</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={agent.p2pReputationScore}
                  onChange={(e) => onUpdate({ ...agent, p2pReputationScore: parseFloat(e.target.value) || 0.8 })}
                />
                <p className="bus-hint">Initial reputation — higher reputation bids are weighted more in consensus</p>
              </div>
            </>
          )}

          {/* P2P Bidder toggle for p2p_orchestrator mode */}
          {orchestrationMode === "p2p_orchestrator" && agent.role !== "human" && (
            <>
              <div className="agent-def-divider">P2P Orchestrator config</div>
              <div className="form-group">
                <label className="bus-toggle-label">
                  <input
                    type="checkbox"
                    checked={agent.p2pBidder}
                    onChange={(e) => onUpdate({ ...agent, p2pBidder: e.target.checked })}
                  />
                  <span>P2P Bidder (can bid on orchestrator's blackboard tasks)</span>
                </label>
              </div>
              {agent.p2pBidder && (
                <>
                  <div className="form-group">
                    <label>Confidence Domains (one per line)</label>
                    <textarea
                      value={agent.p2pConfidenceDomains.join("\n")}
                      onChange={(e) => onUpdate({ ...agent, p2pConfidenceDomains: e.target.value.split("\n").filter(Boolean) })}
                      rows={3}
                      placeholder="data_analysis&#10;web_research&#10;code_review"
                    />
                    <p className="bus-hint">Domains this agent excels at — used for task bidding confidence</p>
                  </div>
                  <div className="form-group">
                    <label>Reputation Score (0-1)</label>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={agent.p2pReputationScore}
                      onChange={(e) => onUpdate({ ...agent, p2pReputationScore: parseFloat(e.target.value) || 0.8 })}
                    />
                    <p className="bus-hint">Initial reputation — higher reputation bids are weighted more in consensus</p>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="agent-def-footer">
        <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete Agent</button>
      </div>
    </div>
  );
}

// ─── Connection Editor ───

function ConnectionPanel({
  conn,
  agents,
  onUpdate,
  onClose,
  onDelete,
}: {
  conn: Connection;
  agents: AgentNode[];
  onUpdate: (c: Connection) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="agent-def-panel">
      <div className="agent-def-header">
        <h3>Connection</h3>
        <button className="btn-icon btn-ghost" onClick={onClose}>&times;</button>
      </div>
      <div className="agent-def-body">
        <div className="agent-def-form">
          <div className="form-row">
            <div className="form-group">
              <label>From</label>
              <select value={conn.from} onChange={(e) => onUpdate({ ...conn, from: e.target.value })}>
                <option value="">Select agent...</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>To</label>
              <select value={conn.to} onChange={(e) => onUpdate({ ...conn, to: e.target.value })}>
                <option value="">Select agent...</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Label</label>
            <input
              value={conn.label}
              onChange={(e) => onUpdate({ ...conn, label: e.target.value })}
              placeholder="e.g. task_assignment"
            />
          </div>
          <div className="form-group">
            <label>Protocol</label>
            <select value={conn.protocol} onChange={(e) => onUpdate({ ...conn, protocol: e.target.value })}>
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>{PROTOCOL_LABELS[p] || p}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Communication Topics (one per line)</label>
            <textarea
              value={conn.topics.join("\n")}
              onChange={(e) => onUpdate({ ...conn, topics: e.target.value.split("\n").filter(Boolean) })}
              rows={3}
              placeholder="parameter_share&#10;clash_flag&#10;acknowledgement"
            />
          </div>
        </div>
      </div>
      <div className="agent-def-footer">
        <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete Connection</button>
      </div>
    </div>
  );
}

// ─── Main Editor ───

export default function AgentEditor({
  onClose,
  onSave,
  initialYaml,
  initialFilename,
}: {
  onClose: () => void;
  onSave: (filename: string, content: string) => void;
  initialYaml?: string;
  initialFilename?: string;
}) {
  const defaultP2PGovernance: P2PGovernance = {
    consensus_mechanism: "contract_net",
    bid_timeout_seconds: 30,
    vote_timeout_seconds: 30,
    min_confidence_threshold: 0.5,
    max_task_retries: 2,
    audit_log: true,
  };

  const [state, setState] = useState<EditorState>({
    systemName: "Multi-Agent System",
    orchestrationMode: "hierarchical",
    agents: [],
    connections: [],
    p2pGovernance: defaultP2PGovernance,
  });

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [connecting, setConnecting] = useState<{ fromId: string; mouseX: number; mouseY: number } | null>(null);
  const [filename, setFilename] = useState(initialFilename?.replace(/\.ya?ml$/i, "") || "agents");
  const [saving, setSaving] = useState(false);
  const [yamlPreview, setYamlPreview] = useState(false);
  const [generatedYaml, setGeneratedYaml] = useState("");
  const [showFileManager, setShowFileManager] = useState(false);
  const [existingFiles, setExistingFiles] = useState<{ filename: string; name: string; agentCount: number; updatedAt: string }[]>([]);
  const [uploadError, setUploadError] = useState("");

  // Auto Architecture state
  const [showAutoArch, setShowAutoArch] = useState(false);
  const [autoArchMessages, setAutoArchMessages] = useState<{ role: "user" | "assistant" | "system"; content: string }[]>([]);
  const [autoArchInput, setAutoArchInput] = useState("");
  const [autoArchType, setAutoArchType] = useState("hierarchical");
  const [autoArchCount, setAutoArchCount] = useState("auto");
  const [autoArchGenerating, setAutoArchGenerating] = useState(false);
  const [autoArchResult, setAutoArchResult] = useState<any>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoArchChatRef = useRef<HTMLDivElement>(null);

  // Auto Architecture handlers
  const openAutoArch = () => {
    setShowAutoArch(true);
    setAutoArchMessages([
      { role: "system", content: "Welcome to Auto Architecture! Describe the agent system you want to build and I'll generate it for you." },
    ]);
    setAutoArchInput("");
    setAutoArchResult(null);
  };

  const handleAutoArchSend = async () => {
    const prompt = autoArchInput.trim();
    if (!prompt || autoArchGenerating) return;

    const newMessages = [...autoArchMessages, { role: "user" as const, content: prompt }];
    setAutoArchMessages(newMessages);
    setAutoArchInput("");
    setAutoArchGenerating(true);

    // Scroll to bottom
    setTimeout(() => autoArchChatRef.current?.scrollTo(0, autoArchChatRef.current.scrollHeight), 50);

    try {
      const res = await api.generateAgentSystem(prompt, autoArchType, autoArchCount);
      if (res.ok && res.system) {
        const sys = res.system;
        const agentCount = sys.agents?.length || 0;
        const connCount = sys.connections?.length || 0;
        setAutoArchResult(sys);
        setAutoArchMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: `I've generated a **${sys.system?.orchestration_mode || autoArchType}** agent system called "${sys.system?.name || "Agent System"}" with **${agentCount} agents** and **${connCount} connections**.\n\nAgents:\n${(sys.agents || []).map((a: any) => `- **${a.name}** (${a.role})`).join("\n")}\n\nClick **"Apply to Editor"** to load this into the editor where you can revise and edit it, then save.`,
          },
        ]);
      } else {
        setAutoArchMessages((prev) => [
          ...prev,
          { role: "assistant" as const, content: `Sorry, generation failed: ${res.error || "Unknown error"}. Please try again with a different description.` },
        ]);
      }
    } catch (err: any) {
      setAutoArchMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: `Error: ${err.message}. Please try again.` },
      ]);
    }
    setAutoArchGenerating(false);
    setTimeout(() => autoArchChatRef.current?.scrollTo(0, autoArchChatRef.current.scrollHeight), 100);
  };

  const applyAutoArchResult = () => {
    if (!autoArchResult) return;
    const sys = autoArchResult;

    // Convert the LLM result into EditorState
    const agents: AgentNode[] = (sys.agents || []).map((a: any, i: number) => ({
      id: a.id || "agent_" + (i + 1),
      name: a.name || "Agent " + (i + 1),
      role: a.role || "worker",
      model: a.model || "",
      persona: a.persona || "",
      responsibilities: a.responsibilities || [],
      x: a.role === "human" ? 50 : a.role === "orchestrator" ? 300 : 150 + (i % 3) * 250,
      y: a.role === "human" ? 200 : a.role === "orchestrator" ? 80 : 100 + Math.floor(i / 3) * 180,
      color: ROLE_COLORS[a.role] || ROLE_COLORS.default,
      busEnabled: a.bus?.enabled || false,
      busTopics: a.bus?.topics || [],
      meshEnabled: a.mesh?.enabled || false,
      p2pConfidenceDomains: a.p2p?.confidence_domains || [],
      p2pReputationScore: a.p2p?.reputation_score ?? 0.8,
      p2pBidder: a.p2p?.bidder === true,
    }));

    const connections: Connection[] = (sys.connections || []).map((c: any) => ({
      id: generateId(),
      from: c.from || "",
      to: c.to || "",
      label: c.label || "connection",
      protocol: c.protocol || "tcp",
      topics: c.topics || [],
    }));

    const p2pGov = sys.system?.p2p_governance;
    setState({
      systemName: sys.system?.name || "Auto-Generated System",
      orchestrationMode: sys.system?.orchestration_mode || autoArchType,
      agents,
      connections,
      p2pGovernance: p2pGov ? {
        consensus_mechanism: p2pGov.consensus_mechanism || "contract_net",
        bid_timeout_seconds: p2pGov.bid_timeout_seconds || 30,
        vote_timeout_seconds: p2pGov.vote_timeout_seconds || 30,
        min_confidence_threshold: p2pGov.min_confidence_threshold || 0.5,
        max_task_retries: p2pGov.max_task_retries || 2,
        audit_log: p2pGov.audit_log !== false,
      } : defaultP2PGovernance,
    });

    setShowAutoArch(false);
    setAutoArchResult(null);
  };

  // Load initial YAML if provided
  useEffect(() => {
    if (initialYaml) {
      loadFromYaml(initialYaml);
    }
    if (initialFilename) {
      setFilename(initialFilename.replace(/\.ya?ml$/i, ""));
    }
    loadExistingFiles();
  }, []);

  const loadExistingFiles = async () => {
    try {
      const files = await api.getAgentConfigs();
      setExistingFiles(Array.isArray(files) ? files : []);
    } catch {
      setExistingFiles([]);
    }
  };

  const handleUploadYaml = (e: React.ChangeEvent<HTMLInputElement>) => {
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
        // Save to server
        const baseName = file.name.replace(/\.ya?ml$/i, "");
        await api.saveAgentConfig(baseName, content);
        // Load into editor
        loadFromYaml(content);
        setFilename(baseName);
        await loadExistingFiles();
      } catch (err: any) {
        setUploadError(err.message || "Upload failed");
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-uploaded
    e.target.value = "";
  };

  const handleLoadFile = async (fname: string) => {
    try {
      const result = await api.getAgentConfig(fname);
      if (result.content) {
        loadFromYaml(result.content);
        setFilename(fname.replace(/\.ya?ml$/i, ""));
        setShowFileManager(false);
      }
    } catch (err: any) {
      console.error("Failed to load file:", err);
    }
  };

  const handleDeleteFile = async (fname: string) => {
    try {
      await api.deleteAgentConfig(fname);
      await loadExistingFiles();
      // If the deleted file is currently loaded, clear the editor
      if (filename === fname.replace(/\.ya?ml$/i, "")) {
        setState({ systemName: "Multi-Agent System", orchestrationMode: "hierarchical", agents: [], connections: [], p2pGovernance: defaultP2PGovernance });
        setFilename("agents");
      }
    } catch (err: any) {
      console.error("Failed to delete file:", err);
    }
  };

  const loadFromYaml = (content: string) => {
    try {
      api.parseAgentYaml(content).then((result: any) => {
        if (result.ok && result.parsed) {
          const parsed = result.parsed;
          const agents: AgentNode[] = (parsed.agents || []).map((a: any, i: number) => ({
            id: a.id || generateId(),
            name: a.name || "Agent " + (i + 1),
            role: a.role || "worker",
            model: a.model || "",
            persona: a.persona || "",
            responsibilities: a.responsibilities || [],
            x: 100 + (i % 3) * 250,
            y: 80 + Math.floor(i / 3) * 200,
            color: ROLE_COLORS[a.role] || ROLE_COLORS.default,
            busEnabled: a.bus?.enabled || false,
            busTopics: a.bus?.topics || [],
            meshEnabled: a.mesh?.enabled || false,
            p2pConfidenceDomains: a.p2p?.confidence_domains || [],
            p2pReputationScore: a.p2p?.reputation_score ?? 0.8,
            p2pBidder: a.p2p?.bidder === true,
          }));

          // Extract connections: prefer explicit connections array, fall back to workflow
          let connections: Connection[] = [];
          if (parsed.connections && Array.isArray(parsed.connections)) {
            connections = parsed.connections.map((c: any) => ({
              id: generateId(),
              from: c.from || "",
              to: c.to || "",
              label: c.label || "connection",
              protocol: c.protocol || "tcp",
              topics: c.topics || [],
            }));
          } else if (parsed.workflow?.sequence) {
            for (const step of parsed.workflow.sequence) {
              if (step.outputs_to) {
                const targets = Array.isArray(step.outputs_to) ? step.outputs_to : [step.outputs_to];
                const fromAgent = step.agent || (step.agents ? step.agents[0] : null);
                if (fromAgent) {
                  for (const to of targets) {
                    connections.push({
                      id: generateId(),
                      from: fromAgent,
                      to,
                      label: step.action?.slice(0, 30) || "handoff",
                      protocol: step.communication?.protocols?.[0] || (step.peer_socket?.enabled ? "tcp" : "queue"),
                      topics: step.peer_socket?.permitted_topics || [],
                    });
                  }
                }
                if (step.agents && step.agents.length > 1 && step.peer_socket?.enabled) {
                  for (let i = 0; i < step.agents.length; i++) {
                    for (let j = i + 1; j < step.agents.length; j++) {
                      connections.push({
                        id: generateId(),
                        from: step.agents[i],
                        to: step.agents[j],
                        label: "peer_socket",
                        protocol: "tcp",
                        topics: step.peer_socket?.permitted_topics || [],
                      });
                    }
                  }
                }
              }
            }
          }

          const loadedP2PGov = parsed.system?.p2p_governance;
          setState({
            systemName: parsed.system?.name || "Multi-Agent System",
            orchestrationMode: parsed.system?.orchestration_mode || "hierarchical",
            agents,
            connections,
            p2pGovernance: loadedP2PGov ? {
              consensus_mechanism: loadedP2PGov.consensus_mechanism || "contract_net",
              bid_timeout_seconds: loadedP2PGov.bid_timeout_seconds || 30,
              vote_timeout_seconds: loadedP2PGov.vote_timeout_seconds || 30,
              min_confidence_threshold: loadedP2PGov.min_confidence_threshold || 0.5,
              max_task_retries: loadedP2PGov.max_task_retries || 2,
              audit_log: loadedP2PGov.audit_log !== false,
            } : defaultP2PGovernance,
          });
        }
      });
    } catch (err) {
      console.error("Failed to parse YAML:", err);
    }
  };

  const addAgent = () => {
    const isP2PMode = state.orchestrationMode === "p2p";
    const isP2POrchMode = state.orchestrationMode === "p2p_orchestrator";
    const newAgent: AgentNode = {
      id: "agent_" + (state.agents.length + 1),
      name: "New Agent",
      role: isP2PMode ? "peer" : "worker",
      model: "",
      persona: "",
      responsibilities: [],
      x: 150 + Math.random() * 300,
      y: 100 + Math.random() * 200,
      color: isP2PMode ? ROLE_COLORS.peer : ROLE_COLORS.worker,
      busEnabled: isP2PMode,
      busTopics: [],
      meshEnabled: false,
      p2pConfidenceDomains: [],
      p2pReputationScore: 0.8,
      p2pBidder: false,
    };
    setState((s) => ({ ...s, agents: [...s.agents, newAgent] }));
    setSelectedAgent(newAgent.id);
    setSelectedConn(null);
  };

  const updateAgent = (updated: AgentNode) => {
    setState((s) => ({
      ...s,
      agents: s.agents.map((a) => (a.id === selectedAgent ? updated : a)),
    }));
  };

  const deleteAgent = (id: string) => {
    setState((s) => ({
      ...s,
      agents: s.agents.filter((a) => a.id !== id),
      connections: s.connections.filter((c) => c.from !== id && c.to !== id),
    }));
    setSelectedAgent(null);
  };

  const updateConnection = (updated: Connection) => {
    setState((s) => ({
      ...s,
      connections: s.connections.map((c) => (c.id === selectedConn ? updated : c)),
    }));
  };

  const deleteConnection = (id: string) => {
    setState((s) => ({
      ...s,
      connections: s.connections.filter((c) => c.id !== id),
    }));
    setSelectedConn(null);
  };

  // Mouse handlers for drag & drop
  const handleMouseDown = useCallback((e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) return;

    setDragging({
      id: agentId,
      offsetX: e.clientX - agent.x,
      offsetY: e.clientY - agent.y,
    });
    setSelectedAgent(agentId);
    setSelectedConn(null);
  }, [state.agents]);

  // Port click starts connection drawing (no shift needed)
  const handlePortMouseDown = useCallback((e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setConnecting({
      fromId: agentId,
      mouseX: e.clientX - rect.left,
      mouseY: e.clientY - rect.top,
    });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, e.clientX - dragging.offsetX);
      const y = Math.max(0, e.clientY - dragging.offsetY);
      setState((s) => ({
        ...s,
        agents: s.agents.map((a) => (a.id === dragging.id ? { ...a, x, y } : a)),
      }));
    }
    if (connecting) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setConnecting({
        ...connecting,
        mouseX: e.clientX - rect.left,
        mouseY: e.clientY - rect.top,
      });
    }
  }, [dragging, connecting]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (connecting) {
      // Check if dropped on an agent
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const target = state.agents.find(
          (a) => a.id !== connecting.fromId &&
            x >= a.x && x <= a.x + 180 &&
            y >= a.y && y <= a.y + 80
        );
        if (target) {
          const newConn: Connection = {
            id: generateId(),
            from: connecting.fromId,
            to: target.id,
            label: "connection",
            protocol: "tcp",
            topics: [],
          };
          setState((s) => ({ ...s, connections: [...s.connections, newConn] }));
          setSelectedConn(newConn.id);
          setSelectedAgent(null);
        }
      }
      setConnecting(null);
    }
    setDragging(null);
  }, [connecting, state.agents]);

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains("editor-canvas-inner")) {
      setSelectedAgent(null);
      setSelectedConn(null);
    }
  };

  // Generate YAML from current state
  const buildYamlObject = () => {
    const systemDef: any = {
      name: state.systemName,
      orchestration_mode: state.orchestrationMode,
      communication_protocol: "structured_handoff",
      context_passing: "full_chain",
    };
    if (state.orchestrationMode === "p2p" || state.orchestrationMode === "p2p_orchestrator") {
      systemDef.p2p_governance = {
        consensus_mechanism: state.p2pGovernance.consensus_mechanism,
        bid_timeout_seconds: state.p2pGovernance.bid_timeout_seconds,
        vote_timeout_seconds: state.p2pGovernance.vote_timeout_seconds,
        min_confidence_threshold: state.p2pGovernance.min_confidence_threshold,
        max_task_retries: state.p2pGovernance.max_task_retries,
        audit_log: state.p2pGovernance.audit_log,
      };
    }
    const yamlObj: any = {
      system: systemDef,
      agents: state.agents.map((a) => {
        const agentDef: any = {
          id: a.id,
          name: a.name,
          role: a.role,
        };
        if (a.model) agentDef.model = a.model;
        if (a.persona) agentDef.persona = a.persona;
        if (a.responsibilities.length > 0) agentDef.responsibilities = a.responsibilities;
        if (a.busEnabled) {
          agentDef.bus = {
            enabled: true,
            topics: a.busTopics.length > 0 ? a.busTopics : undefined,
          };
        }
        if (a.meshEnabled) {
          agentDef.mesh = { enabled: true };
        }
        if (a.role === "peer" || state.orchestrationMode === "p2p" || (state.orchestrationMode === "p2p_orchestrator" && a.p2pBidder)) {
          if (a.p2pConfidenceDomains?.length > 0 || a.p2pReputationScore !== undefined || (state.orchestrationMode === "p2p_orchestrator" && a.p2pBidder)) {
            agentDef.p2p = {
              confidence_domains: a.p2pConfidenceDomains?.length > 0 ? a.p2pConfidenceDomains : undefined,
              reputation_score: a.p2pReputationScore ?? 0.8,
              bidder: (state.orchestrationMode === "p2p_orchestrator" && a.p2pBidder) ? true : undefined,
            };
          }
        }
        return agentDef;
      }),
      workflow: {
        sequence: buildWorkflowSequence(),
      },
      connections: state.connections.map((c) => ({
        from: c.from,
        to: c.to,
        label: c.label,
        protocol: c.protocol,
        topics: c.topics.length > 0 ? c.topics : undefined,
      })),
      communication: {
        format: "structured_json_in_yaml_envelope",
        context_inheritance: {
          mode: "cumulative",
          max_history_tokens: 8000,
        },
      },
    };
    return yamlObj;
  };

  const buildWorkflowSequence = () => {
    // Group connections by source to build workflow steps
    const steps: any[] = [];
    const visited = new Set<string>();

    // Find orchestrator (starting point)
    const orchestrator = state.agents.find((a) => a.role === "orchestrator");
    const startAgent = orchestrator || state.agents[0];
    if (!startAgent) return steps;

    const buildStep = (agentId: string, stepNum: number) => {
      if (visited.has(agentId)) return;
      visited.add(agentId);

      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return;

      const outConns = state.connections.filter((c) => c.from === agentId);
      const targets = outConns.map((c) => c.to).filter((t) => !visited.has(t));

      const step: any = {
        step: stepNum,
        agent: agentId,
        action: agent.responsibilities[0] || `Execute ${agent.name} tasks`,
      };

      if (targets.length > 0) {
        step.outputs_to = targets;
      }

      // Add communication config based on connection protocols
      if (outConns.length > 0) {
        const protocols = [...new Set(outConns.map((c) => c.protocol))];
        step.communication = {
          enabled: true,
          protocols: protocols,
          participants: [agentId, ...targets],
          permitted_topics: outConns.flatMap((c) => c.topics),
        };
        // Add peer_socket if tcp is used
        const tcpConns = outConns.filter((c) => c.protocol === "tcp");
        if (tcpConns.length > 0) {
          step.peer_socket = {
            enabled: true,
            protocol: "bidirectional_async",
            participants: [agentId, ...targets],
            permitted_topics: tcpConns.flatMap((c) => c.topics),
          };
        }
      }

      steps.push(step);

      // Recurse for targets
      for (const t of targets) {
        buildStep(t, steps.length + 1);
      }
    };

    buildStep(startAgent.id, 1);

    // Add any unvisited agents
    for (const a of state.agents) {
      if (!visited.has(a.id)) {
        buildStep(a.id, steps.length + 1);
      }
    }

    return steps;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const yamlObj = buildYamlObject();
      const result = await api.generateAgentYaml(yamlObj);
      if (result.ok) {
        await api.saveAgentConfig(filename, result.content);
        onSave(filename + ".yaml", result.content);
        await loadExistingFiles();
      }
    } catch (err) {
      console.error("Save failed:", err);
    }
    setSaving(false);
  };

  const handlePreviewYaml = async () => {
    const yamlObj = buildYamlObject();
    const result = await api.generateAgentYaml(yamlObj);
    if (result.ok) {
      setGeneratedYaml(result.content);
      setYamlPreview(true);
    }
  };

  // Get positions for connection lines
  const getNodeCenter = (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return { x: 0, y: 0 };
    return { x: agent.x + 90, y: agent.y + 40 };
  };

  // Port positions: output = right edge, input = left edge
  const getOutputPort = (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return { x: 0, y: 0 };
    return { x: agent.x + 180, y: agent.y + 40 };
  };

  const getInputPort = (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return { x: 0, y: 0 };
    return { x: agent.x, y: agent.y + 40 };
  };

  const selectedAgentData = state.agents.find((a) => a.id === selectedAgent);
  const selectedConnData = state.connections.find((c) => c.id === selectedConn);

  return (
    <div className="agent-editor-overlay">
      <div className="agent-editor">
        {/* Toolbar */}
        <div className="editor-toolbar">
          <div className="editor-toolbar-left">
            <button
              className="btn btn-sm auto-arch-btn"
              onClick={openAutoArch}
              title="Generate an agent system automatically using AI"
            >
              Auto Architecture
            </button>
            <h2>Agent System Editor</h2>
            <div className="editor-toolbar-meta">
              <input
                className="system-name-input"
                value={state.systemName}
                onChange={(e) => setState((s) => ({ ...s, systemName: e.target.value }))}
                placeholder="System name..."
              />
              <select
                value={state.orchestrationMode}
                onChange={(e) => setState((s) => ({ ...s, orchestrationMode: e.target.value }))}
                className="orchestration-select"
              >
                <option value="hierarchical">Hierarchical</option>
                <option value="flat">Flat</option>
                <option value="mesh">Mesh</option>
                <option value="hybrid">Hybrid</option>
                <option value="pipeline">Pipeline</option>
                <option value="p2p">P2P Swarm</option>
                <option value="p2p_orchestrator">P2P Orchestrator</option>
              </select>
            </div>
          </div>
          <div className="editor-toolbar-right">
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml"
              style={{ display: "none" }}
              onChange={handleUploadYaml}
            />
            <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
              Upload YAML
            </button>
            <button
              className={`btn btn-sm ${showFileManager ? "btn-primary" : "btn-secondary"}`}
              onClick={() => { setShowFileManager(!showFileManager); loadExistingFiles(); }}
            >
              Files ({existingFiles.length})
            </button>
            <button className="btn btn-secondary btn-sm" onClick={addAgent}>
              + Add Agent
            </button>
            <button
              className="btn btn-sm"
              style={{ background: "#e91e63", color: "#fff", border: "none" }}
              onClick={() => {
                // Only allow one human node
                if (state.agents.some((a) => a.role === "human")) {
                  alert("Only one Human node allowed per system.");
                  return;
                }
                const humanNode: AgentNode = {
                  id: "human",
                  name: "User",
                  role: "human",
                  model: "",
                  persona: "",
                  responsibilities: [],
                  x: 50,
                  y: 50 + state.agents.length * 100,
                  color: ROLE_COLORS.human,
                  busEnabled: false,
                  busTopics: [],
                  meshEnabled: false,
                  p2pConfidenceDomains: [],
                  p2pReputationScore: 1.0,
                  p2pBidder: false,
                };
                setState((s) => ({ ...s, agents: [humanNode, ...s.agents] }));
                setSelectedAgent(humanNode.id);
                setSelectedConn(null);
              }}
              title="Add a Human entry point node"
            >
              + Human Node
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handlePreviewYaml}>
              Preview YAML
            </button>
            <div className="save-group">
              <input
                className="filename-input"
                value={filename}
                onChange={(e) => setFilename(e.target.value.replace(/[^a-zA-Z0-9_\-]/g, ""))}
                placeholder="filename"
              />
              <span className="filename-ext">.yaml</span>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>&times; Close</button>
          </div>
        </div>

        {uploadError && (
          <div className="upload-error-bar">
            {uploadError}
            <button className="btn-icon btn-ghost" onClick={() => setUploadError("")}>&times;</button>
          </div>
        )}

        <div className="editor-body">
          {/* File Manager Panel */}
          {showFileManager && (
            <div className="file-manager-panel">
              <div className="file-manager-header">
                <h3>Architecture Files</h3>
                <button className="btn-icon btn-ghost" onClick={() => setShowFileManager(false)}>&times;</button>
              </div>
              <div className="file-manager-list">
                {existingFiles.length === 0 && (
                  <div className="file-manager-empty">No YAML files yet. Upload or save one.</div>
                )}
                {existingFiles.map((f) => (
                  <div key={f.filename} className="file-manager-item">
                    <div className="file-manager-item-info">
                      <div className="file-manager-item-name">{f.filename}</div>
                      <div className="file-manager-item-meta">
                        {f.name} &middot; {f.agentCount} agent{f.agentCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                    <div className="file-manager-item-actions">
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => handleLoadFile(f.filename)}
                        title="Load into editor"
                      >
                        Load
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDeleteFile(f.filename)}
                        title="Delete file"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="file-manager-footer">
                <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
                  Upload YAML
                </button>
              </div>
            </div>
          )}

          {/* P2P Governance Config (only shown in p2p mode) */}
          {(state.orchestrationMode === "p2p" || state.orchestrationMode === "p2p_orchestrator") && (
            <div className="p2p-governance-panel">
              <div className="p2p-governance-header">P2P Governance Settings</div>
              <div className="p2p-governance-grid">
                <div className="form-group">
                  <label>Consensus Mechanism</label>
                  <select
                    value={state.p2pGovernance.consensus_mechanism}
                    onChange={(e) => setState((s) => ({ ...s, p2pGovernance: { ...s.p2pGovernance, consensus_mechanism: e.target.value } }))}
                  >
                    <option value="contract_net">Contract Net Protocol</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Bid Timeout (s)</label>
                  <input
                    type="number"
                    min="5"
                    max="300"
                    value={state.p2pGovernance.bid_timeout_seconds}
                    onChange={(e) => setState((s) => ({ ...s, p2pGovernance: { ...s.p2pGovernance, bid_timeout_seconds: parseInt(e.target.value) || 30 } }))}
                  />
                </div>
                <div className="form-group">
                  <label>Min Confidence</label>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={state.p2pGovernance.min_confidence_threshold}
                    onChange={(e) => setState((s) => ({ ...s, p2pGovernance: { ...s.p2pGovernance, min_confidence_threshold: parseFloat(e.target.value) || 0.5 } }))}
                  />
                </div>
                <div className="form-group">
                  <label>Max Retries</label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    value={state.p2pGovernance.max_task_retries}
                    onChange={(e) => setState((s) => ({ ...s, p2pGovernance: { ...s.p2pGovernance, max_task_retries: parseInt(e.target.value) || 2 } }))}
                  />
                </div>
                <div className="form-group">
                  <label className="bus-toggle-label">
                    <input
                      type="checkbox"
                      checked={state.p2pGovernance.audit_log}
                      onChange={(e) => setState((s) => ({ ...s, p2pGovernance: { ...s.p2pGovernance, audit_log: e.target.checked } }))}
                    />
                    <span>Audit Log</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Canvas */}
          <div
            ref={canvasRef}
            className="editor-canvas"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onClick={handleCanvasClick}
          >
            <div className="editor-canvas-inner">
              {/* Help text */}
              {state.agents.length === 0 && (
                <div className="editor-empty-hint">
                  Click <strong>"+ Add Agent"</strong> to start building your agent system.<br />
                  Drag agents to position them. Click a <strong>port dot</strong> and drag to another agent to connect.<br />
                  Click a connection line to edit or remove it.
                </div>
              )}

              {/* Mode indicator */}
              {state.orchestrationMode === "mesh" && (
                <div className="mesh-mode-banner">
                  MESH — all agents can freely communicate (no connection lines needed)
                </div>
              )}
              {state.orchestrationMode === "hybrid" && (
                <div className="mesh-mode-banner hybrid-mode-banner">
                  HYBRID — orchestrator controls flow via connections + mesh agents collaborate freely
                </div>
              )}
              {state.orchestrationMode === "p2p" && (
                <div className="mesh-mode-banner p2p-mode-banner">
                  P2P SWARM — autonomous peers self-organize via blackboard + Contract Net Protocol (no connections needed)
                </div>
              )}
              {state.orchestrationMode === "p2p_orchestrator" && (
                <div className="mesh-mode-banner p2p-orch-mode-banner">
                  P2P ORCHESTRATOR — orchestrator delegates directly or posts to blackboard for P2P bidding
                </div>
              )}

              {/* SVG layer for connections (hidden in mesh mode) */}
              <svg className="editor-svg-layer">
                {state.orchestrationMode !== "mesh" && state.orchestrationMode !== "p2p" && state.connections.map((conn) => {
                  const from = getOutputPort(conn.from);
                  const to = getInputPort(conn.to);
                  const isSelected = selectedConn === conn.id;
                  const protocolColor =
                    conn.protocol === "tcp" ? "#4285f4" :
                    conn.protocol === "queue" ? "#ea8600" :
                    "#607d8b";

                  const lineColor = isSelected ? "#e53935" : protocolColor;

                  // Curved line
                  const midX = (from.x + to.x) / 2;
                  const midY = (from.y + to.y) / 2 - 30;
                  const protocolLabel = PROTOCOL_LABELS[conn.protocol] || conn.protocol;

                  return (
                    <g
                      key={conn.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedConn(conn.id);
                        setSelectedAgent(null);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      {/* Invisible fat hit area */}
                      <path
                        d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                        stroke="transparent"
                        strokeWidth={14}
                        fill="none"
                      />
                      <path
                        d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                        stroke={lineColor}
                        strokeWidth={isSelected ? 3 : 2}
                        fill="none"
                        strokeDasharray="none"
                        markerEnd="url(#arrowhead)"
                      />
                      {/* Protocol badge */}
                      <rect
                        x={midX - 20}
                        y={midY - 18}
                        width={40}
                        height={16}
                        rx={4}
                        fill={isSelected ? "#e53935" : protocolColor}
                        opacity={0.85}
                      />
                      <text
                        x={midX}
                        y={midY - 7}
                        textAnchor="middle"
                        fill="#fff"
                        fontSize="10"
                        fontWeight="700"
                        style={{ pointerEvents: "none" }}
                      >
                        {protocolLabel}
                      </text>
                    </g>
                  );
                })}

                {/* Drawing line while connecting (not in mesh mode) */}
                {connecting && state.orchestrationMode !== "mesh" && state.orchestrationMode !== "p2p" && (
                  <line
                    x1={getOutputPort(connecting.fromId).x}
                    y1={getOutputPort(connecting.fromId).y}
                    x2={connecting.mouseX}
                    y2={connecting.mouseY}
                    stroke="#4285f4"
                    strokeWidth={2}
                    strokeDasharray="6,3"
                    opacity={0.7}
                  />
                )}

                {/* Arrow marker */}
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#888" />
                  </marker>
                </defs>
              </svg>

              {/* Agent nodes */}
              {state.agents.map((agent) => {
                const isSelected = selectedAgent === agent.id;
                return (
                  <div
                    key={agent.id}
                    className={`editor-agent-node ${isSelected ? "selected" : ""}`}
                    style={{
                      left: agent.x,
                      top: agent.y,
                      borderColor: agent.color,
                      boxShadow: isSelected ? `0 0 0 2px ${agent.color}, 0 4px 12px rgba(0,0,0,0.3)` : undefined,
                    }}
                    onMouseDown={(e) => handleMouseDown(e, agent.id)}
                    onClick={(e) => { e.stopPropagation(); setSelectedAgent(agent.id); setSelectedConn(null); }}
                  >
                    <div className="agent-node-header" style={{ background: agent.color }}>
                      <span className="agent-node-role">{agent.role === "human" ? "\u{1F464} human" : agent.role}</span>
                    </div>
                    <div className="agent-node-body">
                      <div className="agent-node-name">{agent.name || agent.id}</div>
                      {agent.role !== "human" && (
                        <div className="agent-node-model">{agent.model.split("-").slice(-2).join("-")}</div>
                      )}
                      {agent.role === "human" && (
                        <div className="agent-node-model" style={{ color: "#e91e63", fontSize: "9px" }}>entry point</div>
                      )}
                    </div>
                    {agent.busEnabled && (
                      <div className="agent-node-bus-badge" title={`Bus topics: ${agent.busTopics.join(", ") || "all"}`}>
                        BUS
                      </div>
                    )}
                    {agent.meshEnabled && (
                      <div className="agent-node-mesh-badge" title="Mesh: can send tasks to any agent">
                        MESH
                      </div>
                    )}
                    {agent.role === "peer" && (
                      <div className="agent-node-mesh-badge agent-node-peer-badge" title="P2P peer: autonomous agent with blackboard coordination">
                        PEER
                      </div>
                    )}
                    {agent.p2pBidder && state.orchestrationMode === "p2p_orchestrator" && (
                      <div className="agent-node-mesh-badge agent-node-bidder-badge" title="P2P Bidder: can bid on blackboard tasks">
                        BIDDER
                      </div>
                    )}
                    {state.orchestrationMode !== "mesh" && state.orchestrationMode !== "p2p" && (
                      <>
                        <div className="agent-node-port agent-node-port-in" title="Input port">
                          <div className="port-dot port-dot-in" />
                        </div>
                        <div
                          className="agent-node-port agent-node-port-out"
                          title="Drag to connect"
                          onMouseDown={(e) => handlePortMouseDown(e, agent.id)}
                        >
                          <div className="port-dot" />
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right panel: Agent/Connection definition */}
          {selectedAgentData && (
            <AgentDefPanel
              agent={selectedAgentData}
              onUpdate={updateAgent}
              onClose={() => setSelectedAgent(null)}
              onDelete={() => deleteAgent(selectedAgentData.id)}
              orchestrationMode={state.orchestrationMode}
            />
          )}

          {selectedConnData && state.orchestrationMode !== "mesh" && state.orchestrationMode !== "p2p" && (
            <ConnectionPanel
              conn={selectedConnData}
              agents={state.agents}
              onUpdate={updateConnection}
              onClose={() => setSelectedConn(null)}
              onDelete={() => deleteConnection(selectedConnData.id)}
            />
          )}
        </div>

        {/* Auto Architecture Modal */}
        {showAutoArch && (
          <div className="auto-arch-overlay" onClick={() => !autoArchGenerating && setShowAutoArch(false)}>
            <div className="auto-arch-modal" onClick={(e) => e.stopPropagation()}>
              <div className="auto-arch-header">
                <h3>Auto Architecture</h3>
                <button className="btn-icon btn-ghost" onClick={() => !autoArchGenerating && setShowAutoArch(false)}>&times;</button>
              </div>

              {/* Options bar */}
              <div className="auto-arch-options">
                <div className="auto-arch-option">
                  <label>Architecture Type</label>
                  <select value={autoArchType} onChange={(e) => setAutoArchType(e.target.value)}>
                    <option value="hierarchical">Hierarchical</option>
                    <option value="flat">Flat</option>
                    <option value="mesh">Mesh</option>
                    <option value="hybrid">Hybrid</option>
                    <option value="pipeline">Pipeline</option>
                    <option value="p2p">P2P Swarm</option>
                  </select>
                </div>
                <div className="auto-arch-option">
                  <label>Agent Count</label>
                  <select value={autoArchCount} onChange={(e) => setAutoArchCount(e.target.value)}>
                    <option value="auto">Auto (AI decides)</option>
                    <option value="3">3 agents</option>
                    <option value="4">4 agents</option>
                    <option value="5">5 agents</option>
                    <option value="6">6 agents</option>
                    <option value="7">7 agents</option>
                    <option value="8">8 agents</option>
                  </select>
                </div>
              </div>

              {/* Chat area */}
              <div className="auto-arch-chat" ref={autoArchChatRef}>
                {autoArchMessages.map((msg, i) => (
                  <div key={i} className={`auto-arch-msg auto-arch-msg-${msg.role}`}>
                    <div className="auto-arch-msg-label">
                      {msg.role === "system" ? "System" : msg.role === "user" ? "You" : "AI Architect"}
                    </div>
                    <div className="auto-arch-msg-content">{msg.content}</div>
                  </div>
                ))}
                {autoArchGenerating && (
                  <div className="auto-arch-msg auto-arch-msg-assistant">
                    <div className="auto-arch-msg-label">AI Architect</div>
                    <div className="auto-arch-msg-content auto-arch-thinking">Generating agent system...</div>
                  </div>
                )}
              </div>

              {/* Input area */}
              <div className="auto-arch-input-area">
                {autoArchResult && (
                  <button className="btn btn-primary auto-arch-apply-btn" onClick={applyAutoArchResult}>
                    Apply to Editor
                  </button>
                )}
                <div className="auto-arch-input-row">
                  <textarea
                    value={autoArchInput}
                    onChange={(e) => setAutoArchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleAutoArchSend();
                      }
                    }}
                    placeholder="Describe the agent system you want (e.g. 'A software development team with a project manager, frontend dev, backend dev, and QA tester')..."
                    rows={2}
                    disabled={autoArchGenerating}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleAutoArchSend}
                    disabled={autoArchGenerating || !autoArchInput.trim()}
                  >
                    {autoArchGenerating ? "..." : "Send"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* YAML Preview Modal */}
        {yamlPreview && (
          <div className="yaml-preview-overlay" onClick={() => setYamlPreview(false)}>
            <div className="yaml-preview-modal" onClick={(e) => e.stopPropagation()}>
              <div className="yaml-preview-header">
                <h3>{filename}.yaml</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedYaml);
                    }}
                  >
                    Copy
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setYamlPreview(false)}>
                    &times;
                  </button>
                </div>
              </div>
              <pre className="yaml-preview-content">{generatedYaml}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
