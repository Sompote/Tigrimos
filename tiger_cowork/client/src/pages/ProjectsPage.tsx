import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { api, sandboxUrl } from "../utils/api";
import { useSocket } from "../hooks/useSocket";
import { Icon } from "../components/Layout";
import ReactComponentRenderer from "../components/ReactComponentRenderer";
import "./ProjectsPage.css";

interface Project {
  id: string;
  name: string;
  description: string;
  workingFolder: string;
  memory: string;
  skills: string[];
  createdAt: string;
  updatedAt: string;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
}

interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  path: string;
}

interface Message {
  role: string;
  content: string;
  timestamp: string;
  files?: string[];
}

interface Session {
  id: string;
  title: string;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
}

function getFileExt(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function DocPreview({ file }: { file: string }) {
  const [html, setHtml] = useState<string>("");
  const [info, setInfo] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api.previewFile(file).then((data: any) => {
      if (data.error) {
        setError(data.error);
      } else {
        setHtml(data.html || "");
        if (data.pages) setInfo(`${data.pages} page${data.pages > 1 ? "s" : ""}`);
      }
      setLoading(false);
    }).catch((err: any) => {
      setError(err.message || "Failed to load preview");
      setLoading(false);
    });
  }, [file]);

  if (loading) return <div className="doc-preview-loading">Loading preview...</div>;
  if (error) return <div className="doc-preview-error">Preview unavailable: {error}</div>;

  return (
    <div className="doc-preview-content">
      {info && <div className="doc-preview-info">{info}</div>}
      <div className="doc-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function MarkdownPreview({ file }: { file: string }) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api.previewFile(file).then((data: any) => {
      if (data.error) {
        setError(data.error);
      } else {
        setContent(data.html || "");
      }
      setLoading(false);
    }).catch((err: any) => {
      setError(err.message || "Failed to load preview");
      setLoading(false);
    });
  }, [file]);

  if (loading) return <div className="doc-preview-loading">Loading preview...</div>;
  if (error) return <div className="doc-preview-error">Preview unavailable: {error}</div>;

  return (
    <div className="doc-preview-content markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{content}</ReactMarkdown>
    </div>
  );
}

const codeExts = ["py", "json", "csv", "js", "ts", "tsx", "jsx", "yaml", "yml", "sh", "bash", "sql", "r", "m", "txt", "log", "cfg", "ini", "toml", "xml", "env", "gitignore"];

function TextFilePreview({ file }: { file: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ext = getFileExt(file);

  useEffect(() => {
    setContent(null);
    setError("");
    api.readFile(file).then((data: any) => {
      setContent(data.content || "");
    }).catch((err: any) => {
      setError(err.message || "Failed to load file");
    });
  }, [file]);

  if (error) return <div style={{ color: "#e57373", padding: 16 }}>{error}</div>;
  if (content === null) return <div style={{ padding: 16, opacity: 0.5 }}>Loading...</div>;

  if (ext === "csv") {
    const rows = content.split("\n").filter(Boolean);
    return (
      <div style={{ overflow: "auto", maxHeight: 500 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <tbody>
            {rows.map((row, ri) => {
              const cells = row.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
              return (
                <tr key={ri} style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  {cells.map((cell, ci) => ri === 0 ? (
                    <th key={ci} style={{ padding: "6px 10px", textAlign: "left", background: "rgba(255,255,255,0.05)", fontWeight: 600, position: "sticky", top: 0 }}>{cell}</th>
                  ) : (
                    <td key={ci} style={{ padding: "4px 10px" }}>{cell}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (ext === "json") {
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      return (
        <pre style={{ margin: 0, padding: 12, overflow: "auto", maxHeight: 500, fontSize: 13 }}>{formatted}</pre>
      );
    } catch { /* fall through to plain display */ }
  }

  return (
    <div style={{ overflow: "auto", maxHeight: 500 }}>
      <pre style={{ margin: 0, padding: "8px 0", fontSize: 13 }}>{content.split("\n").map((line, i) => (
        <div key={i} style={{ display: "flex", minHeight: 20 }}>
          <span style={{ display: "inline-block", width: 45, textAlign: "right", paddingRight: 12, color: "rgba(255,255,255,0.25)", userSelect: "none", flexShrink: 0, fontSize: 12 }}>{i + 1}</span>
          <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
        </div>
      ))}</pre>
    </div>
  );
}

function OutputCanvas({ files }: { files: string[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const images = files.filter((f) => ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(getFileExt(f)));
  const reactFiles = files.filter((f) => f.endsWith(".jsx.js"));
  const htmlFiles = files.filter((f) => getFileExt(f) === "html" && !f.endsWith(".jsx.js"));
  const pdfFiles = files.filter((f) => getFileExt(f) === "pdf");
  const docFiles = files.filter((f) => ["doc", "docx"].includes(getFileExt(f)));
  const excelFiles = files.filter((f) => ["xls", "xlsx"].includes(getFileExt(f)));
  const mdFiles = files.filter((f) => getFileExt(f) === "md");
  const textFiles = files.filter((f) => codeExts.includes(getFileExt(f)));
  const otherFiles = files.filter((f) => !images.includes(f) && !reactFiles.includes(f) && !htmlFiles.includes(f) && !pdfFiles.includes(f) && !docFiles.includes(f) && !excelFiles.includes(f) && !mdFiles.includes(f) && !textFiles.includes(f));

  return (
    <div className="output-canvas">
      {images.length > 0 && (
        <div className="canvas-images">
          {images.map((f) => (
            <div key={f} className="canvas-image-wrap">
              <img
                src={sandboxUrl(f, true)}
                alt={f}
                className={`canvas-image ${expanded === f ? "expanded" : ""}`}
                onClick={() => setExpanded(expanded === f ? null : f)}
              />
              <div className="canvas-image-toolbar">
                <span className="canvas-image-name">{f.split("/").pop()}</span>
                <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {reactFiles.map((f) => (
        <div key={f} className="canvas-react-wrap">
          <div className="canvas-html-header">
            <span>{f.split("/").pop()?.replace(".jsx.js", "")}</span>
            <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download source">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            </a>
          </div>
          <div className="canvas-react-body">
            <ReactComponentRenderer src={sandboxUrl(f, true)} />
          </div>
        </div>
      ))}

      {htmlFiles.map((f) => (
        <div key={f} className="canvas-html-wrap">
          <div className="canvas-html-header">
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={sandboxUrl(f)} target="_blank" rel="noreferrer" className="canvas-dl-btn" title="Open in new tab">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </a>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <iframe src={sandboxUrl(f, true)} className="canvas-html-iframe" title={f} />
        </div>
      ))}

      {pdfFiles.map((f) => (
        <div key={f} className="canvas-html-wrap">
          <div className="canvas-html-header">
            <div className="canvas-doc-icon pdf" style={{ marginRight: 6 }}>PDF</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <a href={sandboxUrl(f)} target="_blank" rel="noreferrer" className="canvas-dl-btn" title="Open in new tab">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </a>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <iframe src={sandboxUrl(f)} className="canvas-html-iframe" style={{ height: 700 }} title={f.split("/").pop() || "PDF"} />
        </div>
      ))}

      {docFiles.map((f) => (
        <div key={f} className="canvas-doc-wrap">
          <div className="canvas-doc-header">
            <div className="canvas-doc-icon doc">DOC</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <DocPreview file={f} />
        </div>
      ))}

      {/* Excel file preview */}
      {excelFiles.map((f) => (
        <div key={f} className="canvas-doc-wrap">
          <div className="canvas-doc-header">
            <div className="canvas-doc-icon excel">XLS</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <DocPreview file={f} />
        </div>
      ))}

      {/* Markdown file preview */}
      {mdFiles.map((f) => (
        <div key={f} className="canvas-doc-wrap">
          <div className="canvas-doc-header">
            <div className="canvas-doc-icon md">MD</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <MarkdownPreview file={f} />
        </div>
      ))}

      {textFiles.map((f) => (
        <div key={f} className="canvas-doc-wrap">
          <div className="canvas-doc-header">
            <div className="canvas-doc-icon" style={{ background: "#546e7a" }}>{getFileExt(f).toUpperCase()}</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <TextFilePreview file={f} />
        </div>
      ))}

      {otherFiles.length > 0 && (
        <div className="canvas-other-files">
          {otherFiles.map((f) => (
            <a key={f} href={api.downloadUrl(f)} className="file-chip" download>
              <span className="file-chip-icon">{getFileExt(f).toUpperCase() || "FILE"}</span>
              {f.split("/").pop()}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Project Chat ─── */
function ProjectChat({ project, allSkills }: { project: Project; allSkills: Skill[] }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [outputPanelOpen, setOutputPanelOpen] = useState(true);
  const [mobileSessions, setMobileSessions] = useState(false);
  const [activeTaskSessions, setActiveTaskSessions] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { connected, sendProjectMessage, onChunk, onResponse, onStatus } = useSocket();

  // Collect all output files from messages for the right panel
  const allOutputFiles = messages.reduce<{ files: string[]; msgIndex: number }[]>((acc, msg, i) => {
    if (msg.files && msg.files.length > 0) {
      acc.push({ files: msg.files, msgIndex: i });
    }
    return acc;
  }, []);

  // Load sessions that belong to this project (prefixed with [ProjectName])
  useEffect(() => {
    api.getSessions().then((all: Session[]) => {
      const prefix = `[${project.name}]`;
      const projectSessions = all.filter((s) => s.title.startsWith(prefix));
      setSessions(projectSessions);
    });
  }, [project.id, project.name]);

  useEffect(() => {
    if (activeSession) {
      api.getSession(activeSession).then((session: any) => {
        setMessages(session.messages || []);
      });
    }
  }, [activeSession]);

  const toolLabels: Record<string, string> = {
    web_search: "Searching the web", fetch_url: "Fetching URL", run_python: "Running Python",
    run_react: "Running React", run_shell: "Running command", read_file: "Reading file",
    write_file: "Writing file", list_files: "Listing files", list_skills: "Listing skills",
    load_skill: "Loading skill", clawhub_search: "Searching ClawHub", clawhub_install: "Installing skill",
    spawn_subagent: "Spawning sub-agent", send_task: "Delegating task",
    wait_result: "Waiting for agent", check_agents: "Checking agents",
  };

  // Restore in-progress state on mount, reconnect, or session switch
  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;

    const checkActiveTasks = () => {
      api.getActiveTasks().then((tasks: any[]) => {
        if (cancelled) return;
        // Use API as additive source — only "done" status events should remove sessions
        const apiSessions = new Set(tasks.map((t: any) => t.sessionId).filter(Boolean));
        setActiveTaskSessions((prev) => {
          const merged = new Set(prev);
          for (const s of apiSessions) merged.add(s);
          if (merged.size === prev.size) return prev;
          return merged;
        });
        const activeTask = tasks.find((t: any) => t.sessionId === activeSession);
        if (activeTask) {
          setIsLoading(true);
          if (activeTask.status.startsWith("Running:")) {
            const rawTool = activeTask.status.replace("Running: ", "");
            const tool = rawTool.split(" — ")[0];
            const detail = rawTool.includes(" — ") ? rawTool.split(" — ")[1] : "";
            if (tool === "wait_result" && detail) {
              setStatus(`Waiting for ${detail}...`);
            } else if (tool === "send_task" && detail) {
              setStatus(`${detail}...`);
            } else {
              const label = toolLabels[tool] || tool;
              setStatus(`${label}...`);
            }
          } else if (activeTask.status.includes("done, thinking") || activeTask.status.includes("orchestrating") || activeTask.status.includes("received")) {
            setStatus(activeTask.status);
          } else {
            setStatus("Thinking...");
          }
        }
      }).catch(() => {});
    };

    checkActiveTasks();
    const interval = setInterval(() => {
      if (!cancelled) checkActiveTasks();
    }, 5000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [activeSession, connected]);

  useEffect(() => {
    const unsub1 = onChunk((data) => {
      if (data.sessionId === activeSession) {
        setStreaming((prev) => prev + data.content);
      }
    });
    const unsub2 = onResponse((data) => {
      // Don't clear activeTaskSessions here — let the "done" status handle it
      if (data.sessionId === activeSession) {
        api.getSession(activeSession).then((session: any) => {
          setMessages(session.messages || []);
        });
        setStreaming("");
        setIsLoading(false);
        setStatus("");
      }
    });
    const unsub3 = onStatus((data: any) => {
      // Clear active dot on "done" status
      if (data.status === "done" && data.sessionId) {
        setActiveTaskSessions((prev) => {
          const next = new Set(prev);
          next.delete(data.sessionId);
          if (next.size === prev.size) return prev;
          return next;
        });
      }
      if (data.sessionId && (data.status === "thinking" || data.status === "tool_call" || data.status === "running_python" || data.status === "retrying")) {
        setActiveTaskSessions((prev) => {
          if (prev.has(data.sessionId)) return prev;
          const next = new Set(prev);
          next.add(data.sessionId);
          return next;
        });
      }

      if (data.sessionId && data.sessionId !== activeSession) return;

      if (data.status === "thinking") { setIsLoading(true); setStatus("Thinking..."); }
      else if (data.status === "tool_call") {
        setIsLoading(true);
        if (data.tool === "send_task" && data.args) {
          const target = data.args.to || "agent";
          const taskPreview = data.args.task ? ` — ${data.args.task.slice(0, 60)}` : "";
          setStatus(`Delegating to ${target}${taskPreview}...`);
        } else if (data.tool === "wait_result" && data.args) {
          setStatus(`Waiting for ${data.args.from || "agent"} to finish...`);
        } else {
          setStatus(`${toolLabels[data.tool] || data.tool}...`);
        }
      }
      else if (data.status === "tool_result") {
        if (data.tool === "wait_result") setStatus("Agent result received, thinking...");
        else if (data.tool === "send_task") setStatus("Task delegated, orchestrating...");
        else setStatus(`${toolLabels[data.tool] || data.tool} done, thinking...`);
      }
      else if (data.status === "subagent_spawn") { setIsLoading(true); setStatus(`Sub-agent "${data.label}" spawned...`); }
      else if (data.status === "subagent_tool") { setIsLoading(true); setStatus(`Sub-agent "${data.label}": ${toolLabels[data.tool] || data.tool}...`); }
      else if (data.status === "subagent_done") setStatus(`Sub-agent "${data.label}" completed`);
      else if (data.status === "subagent_error") setStatus(`Sub-agent "${data.label}" failed: ${data.error}`);
      else setStatus("");
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [activeSession, onChunk, onResponse, onStatus]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const createNewSession = async () => {
    const session = await api.createSession(`[${project.name}] New chat`);
    setSessions((prev) => [session, ...prev]);
    setActiveSession(session.id);
    setMessages([]);
  };

  const handleSend = useCallback(() => {
    if (!input.trim() || isLoading) return;
    const msg = input.trim();
    const userMessage: Message = { role: "user", content: msg, timestamp: new Date().toISOString() };
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    if (!activeSession) {
      const title = `[${project.name}] ${msg.slice(0, 40)}`;
      api.createSession(title).then((session: any) => {
        setSessions((prev) => [session, ...prev]);
        setActiveSession(session.id);
        setMessages([userMessage]);
        setIsLoading(true);
        sendProjectMessage(project.id, session.id, msg);
      });
    } else {
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      sendProjectMessage(project.id, activeSession, msg);
    }
  }, [input, activeSession, isLoading, sendProjectMessage, project]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSession === id) { setActiveSession(null); setMessages([]); }
  };

  // Build context info for display
  const selectedSkillNames = allSkills.filter((s) => project.skills?.includes(s.id)).map((s) => s.name);

  return (
    <div className="project-chat">
      {/* Context banner */}
      <div className="project-chat-context">
        <div className="context-items">
          {project.memory && <span className="context-chip memory">Memory loaded</span>}
          {project.workingFolder && <span className="context-chip folder">{project.workingFolder.split("/").pop()}</span>}
          {selectedSkillNames.map((s) => <span key={s} className="context-chip skill">{s}</span>)}
        </div>
      </div>

      <div className="project-chat-body">
        {/* Mobile session toggle button */}
        <button className="mobile-sessions-toggle" onClick={() => setMobileSessions(true)}>
          <Icon name="chat" />
          <span>{activeSession ? sessions.find(s => s.id === activeSession)?.title?.replace(`[${project.name}] `, "") || "Chat" : "Sessions"}</span>
        </button>

        {/* Mobile backdrop */}
        <div className={`mobile-sessions-backdrop ${mobileSessions ? "visible" : ""}`} onClick={() => setMobileSessions(false)} />

        {/* Session sidebar */}
        <div className={`project-chat-sessions ${mobileSessions ? "mobile-open" : ""}`}>
          <button className="btn btn-primary btn-sm" onClick={createNewSession} style={{ width: "100%" }}>
            <Icon name="add" /> New Chat
          </button>
          <div className="project-session-list">
            {sessions.map((s) => (
              <div key={s.id} className={`session-item ${activeSession === s.id ? "active" : ""}`} onClick={() => { setActiveSession(s.id); setMobileSessions(false); }}>
                {activeTaskSessions.has(s.id) && <span className="session-running-indicator" title="Task running" />}
                <span className="session-title">{s.title.replace(`[${project.name}] `, "")}</span>
                <button className="session-delete btn-icon btn-ghost" onClick={(e) => deleteSession(s.id, e)}>
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div className="project-chat-main">
          {!activeSession && messages.length === 0 ? (
            <div className="project-chat-empty">
              <h3>Chat with {project.name}</h3>
              <p>The agent has access to your project memory, working folder, and selected skills.</p>
              <div className="project-chat-suggestions">
                {["What files are in the working folder?", "Summarize the project memory", "Help me with this project"].map((s) => (
                  <button key={s} className="suggestion-chip" onClick={() => { setInput(s); textareaRef.current?.focus(); }}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="project-chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-avatar">{msg.role === "user" ? "U" : "C"}</div>
                  <div className="message-content">
                    {msg.role === "assistant" ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{msg.content}</ReactMarkdown>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    {msg.files && msg.files.length > 0 && (
                      <div className="message-output-indicator" onClick={() => setOutputPanelOpen(true)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
                        {msg.files.length} output{msg.files.length > 1 ? "s" : ""} — view in panel
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="message assistant">
                  <div className="message-avatar">C</div>
                  <div className="message-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{streaming}</ReactMarkdown>
                  </div>
                </div>
              )}
              {status && <div className="chat-status">{status}</div>}
              <div ref={messagesEndRef} />
            </div>
          )}

          <div className="project-chat-input-area">
            <div className="project-chat-input-wrapper">
              <textarea
                ref={textareaRef}
                className="chat-input"
                placeholder={`Message ${project.name}...`}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 200) + "px";
                }}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={isLoading}
              />
              <button
                className={`send-btn ${input.trim() ? "active" : ""}`}
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </div>
            <div className="project-chat-hint">
              {connected ? "Connected" : "Disconnected"} · Project context active · Enter to send
            </div>
          </div>
        </div>

        {/* Right-side Output Panel */}
        {allOutputFiles.length > 0 && outputPanelOpen && (
          <div className="output-panel">
            <div className="output-panel-header">
              <h3>Outputs</h3>
              <button className="btn-icon btn-ghost" onClick={() => setOutputPanelOpen(false)}>
                <Icon name="close" />
              </button>
            </div>
            <div className="output-panel-content">
              {allOutputFiles.map((group, gi) => (
                <OutputCanvas key={gi} files={group.files} />
              ))}
            </div>
          </div>
        )}

        {/* Toggle button when panel is closed but outputs exist */}
        {allOutputFiles.length > 0 && !outputPanelOpen && (
          <button className="output-panel-toggle" onClick={() => setOutputPanelOpen(true)} title="Show outputs">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
            <span className="output-toggle-badge">{allOutputFiles.reduce((n, g) => n + g.files.length, 0)}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main ProjectsPage ─── */
export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<"chat" | "overview" | "memory" | "skills" | "files">("chat");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [sandboxDir, setSandboxDir] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [memoryGenerating, setMemoryGenerating] = useState(false);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [projectFiles, setProjectFiles] = useState<FileEntry[]>([]);
  const [filePath, setFilePath] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editFolder, setEditFolder] = useState("");
  const [mobileSidebar, setMobileSidebar] = useState(false);

  useEffect(() => {
    api.getProjects().then(setProjects);
    api.getSkills().then(setAllSkills);
    api.getSettings().then((s: any) => setSandboxDir(s.sandboxDir || ""));
  }, []);

  useEffect(() => {
    if (activeProject) {
      // Fetch memory from file (memory.md in working folder) via API
      api.getProjectMemory(activeProject.id).then((data: any) => {
        setMemoryContent(data.content || "");
      }).catch(() => {
        setMemoryContent(activeProject.memory || "");
      });
      setMemoryDirty(false);
      setMemoryEditing(false);
      setFilePath("");
      loadFiles(activeProject, "");
    }
  }, [activeProject?.id]);

  const loadFiles = async (project: Project, subPath: string) => {
    if (!project.workingFolder) { setProjectFiles([]); return; }
    try {
      const data = await api.getProjectFiles(project.id, subPath);
      setProjectFiles(data.files || []);
    } catch { setProjectFiles([]); }
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    const project = await api.createProject({
      name: newName.trim(),
      description: newDesc.trim(),
      workingFolder: newFolder.trim(),
    });
    setProjects((prev) => [...prev, project]);
    setActiveProject(project);
    setCreating(false);
    setNewName(""); setNewDesc(""); setNewFolder("");
  };

  const deleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this project?")) return;
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeProject?.id === id) setActiveProject(null);
  };

  const saveMemory = async () => {
    if (!activeProject) return;
    setMemorySaving(true);
    await api.saveProjectMemory(activeProject.id, memoryContent);
    const updated = { ...activeProject, memory: memoryContent };
    setActiveProject(updated);
    setProjects((prev) => prev.map((p) => p.id === updated.id ? updated : p));
    setMemoryDirty(false);
    setMemorySaving(false);
    setMemoryEditing(false);
  };

  const generateMemory = async () => {
    if (!activeProject) return;
    setMemoryGenerating(true);
    try {
      const data = await api.generateProjectMemory(activeProject.id);
      if (data.content) {
        setMemoryContent(data.content);
        setMemoryDirty(true);
        setMemoryEditing(true);
      } else if (data.error) {
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message || "Failed to generate memory");
    }
    setMemoryGenerating(false);
  };

  const toggleSkill = async (skillId: string) => {
    if (!activeProject) return;
    const current = activeProject.skills || [];
    const updated = current.includes(skillId) ? current.filter((s) => s !== skillId) : [...current, skillId];
    const project = await api.updateProject(activeProject.id, { skills: updated });
    setActiveProject(project);
    setProjects((prev) => prev.map((p) => p.id === project.id ? project : p));
  };

  const saveEdit = async () => {
    if (!activeProject) return;
    const project = await api.updateProject(activeProject.id, {
      name: editName.trim() || activeProject.name,
      description: editDesc.trim(),
      workingFolder: editFolder.trim(),
    });
    setActiveProject(project);
    setProjects((prev) => prev.map((p) => p.id === project.id ? project : p));
    setEditing(false);
  };

  const startEdit = () => {
    if (!activeProject) return;
    setEditName(activeProject.name);
    setEditDesc(activeProject.description);
    setEditFolder(activeProject.workingFolder);
    setEditing(true);
  };

  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [selectedProjFiles, setSelectedProjFiles] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const navigateFile = (entry: FileEntry) => {
    if (!activeProject) return;
    if (entry.isDirectory) { setFilePath(entry.path); loadFiles(activeProject, entry.path); setPreviewFile(null); setSelectedProjFiles(new Set()); }
  };

  const clickFile = async (entry: FileEntry) => {
    if (!activeProject || entry.isDirectory) return;
    // Get the sandbox-relative path for display in output panel
    try {
      const data = await api.projectSandboxPath(activeProject.id, entry.path);
      setPreviewFile(data.sandboxPath);
    } catch {
      setPreviewFile(null);
    }
  };

  const navigateUp = () => {
    if (!activeProject) return;
    const parent = filePath.split("/").slice(0, -1).join("/");
    setFilePath(parent);
    loadFiles(activeProject, parent);
    setPreviewFile(null);
    setSelectedProjFiles(new Set());
  };

  const handleProjectUpload = async (files: FileList | null) => {
    if (!files || !activeProject) return;
    for (let i = 0; i < files.length; i++) {
      await api.projectUploadFile(activeProject.id, files[i], filePath || undefined);
    }
    loadFiles(activeProject, filePath);
  };

  const handleProjectMkdir = async () => {
    if (!mkdirName.trim() || !activeProject) return;
    await api.projectMkdir(activeProject.id, mkdirName.trim(), filePath || undefined);
    setMkdirName("");
    setMkdirOpen(false);
    loadFiles(activeProject, filePath);
  };

  const handleProjectDelete = async (entry: FileEntry) => {
    if (!activeProject) return;
    if (!confirm(`Delete "${entry.name}"?`)) return;
    await api.projectDeleteFile(activeProject.id, entry.path);
    if (previewFile) setPreviewFile(null);
    loadFiles(activeProject, filePath);
  };

  const toggleProjFileSelect = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedProjFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const selectAllProjFiles = () => {
    if (selectedProjFiles.size === projectFiles.length) {
      setSelectedProjFiles(new Set());
    } else {
      setSelectedProjFiles(new Set(projectFiles.map((f) => f.path)));
    }
  };

  const deleteSelectedProjFiles = async () => {
    if (!activeProject || selectedProjFiles.size === 0) return;
    if (!confirm(`Delete ${selectedProjFiles.size} item(s)?`)) return;
    for (const p of selectedProjFiles) {
      try { await api.projectDeleteFile(activeProject.id, p); } catch {}
    }
    if (previewFile) setPreviewFile(null);
    setSelectedProjFiles(new Set());
    loadFiles(activeProject, filePath);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const TABS = [
    { key: "chat" as const, label: "Chat" },
    { key: "overview" as const, label: "Overview" },
    { key: "memory" as const, label: "Memory" },
    { key: "skills" as const, label: "Skills" },
    { key: "files" as const, label: "Files" },
  ];

  return (
    <div className="projects-page">
      <div className={`projects-sidebar-backdrop ${mobileSidebar ? "visible" : ""}`} onClick={() => setMobileSidebar(false)} />
      <div className={`projects-sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
        <button className="btn btn-primary new-project-btn" onClick={() => setCreating(true)}>
          <Icon name="add" /> New Project
        </button>

        {creating && (
          <div className="project-create-form">
            <input
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
              autoFocus
            />
            <input
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <div>
              <input
                placeholder="Folder name (optional, e.g. my-project)"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
              />
              {sandboxDir && <span className="hint" style={{ fontSize: 10 }}>Path: {sandboxDir}/{newFolder || "..."}</span>}
            </div>
            <div className="project-create-actions">
              <button className="btn btn-primary btn-sm" onClick={createProject} disabled={!newName.trim()}>Create</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="project-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-item ${activeProject?.id === p.id ? "active" : ""}`}
              onClick={() => { setActiveProject(p); setMobileSidebar(false); setEditing(false); setTab("chat"); }}
            >
              <div className="project-item-icon"><Icon name="project" /></div>
              <div className="project-item-info">
                <span className="project-item-name">{p.name}</span>
                {p.description && <span className="project-item-desc">{p.description}</span>}
              </div>
              <button className="project-delete btn-icon btn-ghost" onClick={(e) => deleteProject(p.id, e)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
          {projects.length === 0 && !creating && (
            <div className="projects-empty">No projects yet</div>
          )}
        </div>
      </div>

      <div className="projects-main">
        <button className="mobile-projects-toggle" onClick={() => setMobileSidebar(true)}>
          <Icon name="project" />
          <span>{activeProject ? activeProject.name : "Projects"}</span>
        </button>

        {!activeProject ? (
          <div className="projects-welcome">
            <h1>Projects</h1>
            <p>Create a project to organize your work with a dedicated working folder, memory notes, and skill selection.</p>
            <button className="btn btn-primary" onClick={() => { setCreating(true); setMobileSidebar(true); }}>
              Create your first project
            </button>
          </div>
        ) : (
          <div className="project-detail">
            <div className="project-detail-header">
              <div className="project-detail-title">
                <h2>{activeProject.name}</h2>
                {activeProject.description && <p className="project-detail-desc">{activeProject.description}</p>}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={startEdit}>Edit</button>
            </div>

            {editing && (
              <div className="project-edit-form card">
                <div className="form-group">
                  <label>Name</label>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Working Folder</label>
                  <input value={editFolder} onChange={(e) => setEditFolder(e.target.value)} placeholder="Folder name (e.g. my-project)" />
                  {sandboxDir && <span className="hint" style={{ fontSize: 10 }}>Path: {sandboxDir}/{editFolder || "..."}</span>}
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className="project-tabs">
              {TABS.map((t) => (
                <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className={`project-tab-content ${tab === "chat" ? "chat-tab-active" : ""} ${tab === "files" ? "files-tab-active" : ""}`}>
              {tab === "chat" && (
                <ProjectChat project={activeProject} allSkills={allSkills} />
              )}

              {tab === "overview" && (
                <div className="project-overview">
                  <div className="overview-cards">
                    <div className="overview-card" onClick={() => setTab("files")}>
                      <div className="overview-card-icon"><Icon name="folder" /></div>
                      <div className="overview-card-info">
                        <strong>Working Folder</strong>
                        <span>{activeProject.workingFolder || "Not set"}</span>
                      </div>
                    </div>
                    <div className="overview-card" onClick={() => setTab("memory")}>
                      <div className="overview-card-icon"><Icon name="chat" /></div>
                      <div className="overview-card-info">
                        <strong>Memory</strong>
                        <span>{activeProject.memory ? `${activeProject.memory.split("\n").length} lines` : "Empty"}</span>
                      </div>
                    </div>
                    <div className="overview-card" onClick={() => setTab("skills")}>
                      <div className="overview-card-icon"><Icon name="extension" /></div>
                      <div className="overview-card-info">
                        <strong>Skills</strong>
                        <span>{activeProject.skills?.length || 0} selected</span>
                      </div>
                    </div>
                  </div>
                  <div className="overview-meta">
                    <span>Created: {new Date(activeProject.createdAt).toLocaleDateString()}</span>
                    <span>Updated: {new Date(activeProject.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              )}

              {tab === "memory" && (
                <div className="project-memory">
                  <div className="memory-header">
                    <div>
                      <h3>Project Memory</h3>
                      <p className="hint">Record project characteristics, decisions, and notes. The agent reads this as context.</p>
                    </div>
                    <div className="memory-actions">
                      {memoryEditing ? (
                        <>
                          {memoryDirty && (
                            <button className="btn btn-primary btn-sm" onClick={saveMemory} disabled={memorySaving}>
                              {memorySaving ? "Saving..." : "Save"}
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" onClick={() => { setMemoryContent(activeProject.memory || ""); setMemoryDirty(false); setMemoryEditing(false); }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-ghost btn-sm" onClick={() => setMemoryEditing(true)}>
                            Edit
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={generateMemory} disabled={memoryGenerating}>
                            {memoryGenerating ? "Generating..." : "Generate from Chat"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {memoryEditing ? (
                    <textarea
                      className="memory-editor"
                      value={memoryContent}
                      onChange={(e) => { setMemoryContent(e.target.value); setMemoryDirty(true); }}
                      placeholder={"# Project Memory\n\nRecord project info here...\n\n## Tech Stack\n- ...\n\n## Key Decisions\n- ...\n\n## Notes\n- ..."}
                      autoFocus
                    />
                  ) : (
                    <div className="memory-view">
                      {memoryContent ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{memoryContent}</ReactMarkdown>
                      ) : (
                        <div className="memory-empty">
                          <p>No memory recorded yet.</p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button className="btn btn-primary btn-sm" onClick={() => setMemoryEditing(true)}>Add Memory</button>
                            <button className="btn btn-secondary btn-sm" onClick={generateMemory} disabled={memoryGenerating}>
                              {memoryGenerating ? "Generating..." : "Generate from Chat"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "skills" && (
                <div className="project-skills">
                  <h3>Select Skills for this Project</h3>
                  <p className="hint">Choose which skills are available when working in this project. These are prioritized during search.</p>
                  <div className="skill-select-list">
                    {allSkills.map((skill) => {
                      const selected = activeProject.skills?.includes(skill.id) || false;
                      return (
                        <div key={skill.id} className={`skill-select-item ${selected ? "selected" : ""}`} onClick={() => toggleSkill(skill.id)}>
                          <div className="skill-select-check">
                            {selected ? (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent)">
                                <path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                              </svg>
                            ) : (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-tertiary)">
                                <path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                              </svg>
                            )}
                          </div>
                          <div className="skill-select-info">
                            <span className="skill-select-name">{skill.name}</span>
                            <span className="skill-select-desc">{skill.description}</span>
                          </div>
                          <span className={`source-badge ${skill.source}`}>{skill.source}</span>
                        </div>
                      );
                    })}
                    {allSkills.length === 0 && (
                      <div className="projects-empty">No skills installed. Go to Skills page to install some.</div>
                    )}
                  </div>
                </div>
              )}

              {tab === "files" && (
                <div className="project-files-layout">
                  <div className="project-files">
                    <div className="files-header">
                      <h3>Working Folder</h3>
                      {activeProject.workingFolder && <span className="hint">{activeProject.workingFolder}</span>}
                    </div>
                    {!activeProject.workingFolder ? (
                      <div className="projects-empty">
                        <p>No working folder set.</p>
                        <button className="btn btn-ghost btn-sm" onClick={startEdit}>Set working folder</button>
                      </div>
                    ) : (
                      <>
                        {/* Toolbar */}
                        <div className="files-toolbar">
                          <div className="files-toolbar-left">
                            {filePath && (
                              <button className="btn btn-ghost btn-sm" onClick={navigateUp}>&larr; Back</button>
                            )}
                            <span className="files-path-label">/{filePath || ""}</span>
                          </div>
                          <div className="files-toolbar-right">
                            {projectFiles.length > 0 && (
                              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13, opacity: 0.8 }}>
                                <input
                                  type="checkbox"
                                  checked={selectedProjFiles.size === projectFiles.length && projectFiles.length > 0}
                                  onChange={selectAllProjFiles}
                                  style={{ cursor: "pointer" }}
                                />
                                All
                              </label>
                            )}
                            {selectedProjFiles.size > 0 && (
                              <button className="btn btn-ghost btn-sm" onClick={deleteSelectedProjFiles} style={{ color: "#e57373" }}>
                                Delete ({selectedProjFiles.size})
                              </button>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => setMkdirOpen(!mkdirOpen)} title="New folder">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm0 12H4V8h16v10zM11 13h2v-2h2v2h2v2h-2v2h-2v-2h-2z"/></svg>
                              New Folder
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} title="Upload files">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
                              Upload
                            </button>
                            <input
                              ref={fileInputRef}
                              type="file"
                              multiple
                              style={{ display: "none" }}
                              onChange={(e) => { handleProjectUpload(e.target.files); e.target.value = ""; }}
                            />
                          </div>
                        </div>

                        {/* Mkdir inline form */}
                        {mkdirOpen && (
                          <div className="files-mkdir-form">
                            <input
                              placeholder="Folder name"
                              value={mkdirName}
                              onChange={(e) => setMkdirName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleProjectMkdir(); if (e.key === "Escape") setMkdirOpen(false); }}
                              autoFocus
                            />
                            <button className="btn btn-primary btn-sm" onClick={handleProjectMkdir} disabled={!mkdirName.trim()}>Create</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => { setMkdirOpen(false); setMkdirName(""); }}>Cancel</button>
                          </div>
                        )}

                        {/* File list */}
                        <div className="project-file-list">
                          {projectFiles.map((f) => (
                            <div
                              key={f.path}
                              className={`project-file-item ${!f.isDirectory && previewFile ? "clickable" : ""}`}
                              onClick={() => f.isDirectory ? navigateFile(f) : clickFile(f)}
                            >
                              <input
                                type="checkbox"
                                checked={selectedProjFiles.has(f.path)}
                                onClick={(e) => toggleProjFileSelect(f.path, e)}
                                onChange={() => {}}
                                style={{ cursor: "pointer", marginRight: 4, flexShrink: 0 }}
                              />
                              <span className="file-icon">{f.isDirectory ? "📁" : "📄"}</span>
                              <span className="file-name">{f.name}</span>
                              {!f.isDirectory && <span className="file-size">{formatSize(f.size)}</span>}
                              <div className="file-actions" onClick={(e) => e.stopPropagation()}>
                                {!f.isDirectory && (
                                  <a href={api.projectDownloadUrl(activeProject.id, f.path)} download className="file-action-btn" title="Download">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                                  </a>
                                )}
                                <button className="file-action-btn delete" onClick={() => handleProjectDelete(f)} title="Delete">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                                </button>
                              </div>
                            </div>
                          ))}
                          {projectFiles.length === 0 && <div className="projects-empty">Folder is empty</div>}
                        </div>
                      </>
                    )}
                  </div>

                  {/* File Preview Panel */}
                  {previewFile && (
                    <div className="project-file-preview">
                      <div className="preview-header">
                        <span className="preview-filename">{previewFile.split("/").pop()}</span>
                        <button className="btn-icon btn-ghost" onClick={() => setPreviewFile(null)}>
                          <Icon name="close" />
                        </button>
                      </div>
                      <div className="preview-content">
                        <OutputCanvas files={[previewFile]} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
