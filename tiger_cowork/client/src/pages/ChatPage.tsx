import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { api, sandboxUrl } from "../utils/api";
import { useSocket } from "../hooks/useSocket";
import { Icon } from "../components/Layout";
import ReactComponentRenderer from "../components/ReactComponentRenderer";
import "./ChatPage.css";

interface AttachedFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

interface Message {
  role: string;
  content: string;
  timestamp: string;
  files?: string[];
  attachments?: AttachedFile[];
}

interface Session {
  id: string;
  title: string;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["pdf"].includes(ext)) return "PDF";
  if (["doc", "docx"].includes(ext)) return "DOC";
  if (["xls", "xlsx", "csv"].includes(ext)) return "XLS";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "IMG";
  if (["py", "js", "ts", "html", "css", "json", "md", "yaml", "yml", "xml"].includes(ext)) return "TXT";
  if (["zip", "tar", "gz"].includes(ext)) return "ZIP";
  return "FILE";
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

function OutputCanvas({ files }: { files: string[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const images = files.filter((f) => ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(getFileExt(f)));
  const reactFiles = files.filter((f) => f.endsWith(".jsx.js"));
  const htmlFiles = files.filter((f) => getFileExt(f) === "html" && !f.endsWith(".jsx.js"));
  const pdfFiles = files.filter((f) => getFileExt(f) === "pdf");
  const docFiles = files.filter((f) => ["doc", "docx"].includes(getFileExt(f)));
  const excelFiles = files.filter((f) => ["xls", "xlsx"].includes(getFileExt(f)));
  const mdFiles = files.filter((f) => getFileExt(f) === "md");
  const otherFiles = files.filter((f) => !images.includes(f) && !reactFiles.includes(f) && !htmlFiles.includes(f) && !pdfFiles.includes(f) && !docFiles.includes(f) && !excelFiles.includes(f) && !mdFiles.includes(f));

  return (
    <div className="output-canvas">
      {/* Inline images (charts, plots) */}
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

      {/* Native React components (compiled JSX) */}
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

      {/* HTML reports in iframe */}
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

      {/* PDF preview with native iframe viewer */}
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

      {/* Word document preview */}
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

      {/* Other files as download chips */}
      {otherFiles.length > 0 && (
        <div className="canvas-other-files">
          {otherFiles.map((f) => (
            <a key={f} href={api.downloadUrl(f)} className="file-chip" download>
              <span className="file-chip-icon">{getFileIcon(f)}</span>
              {f.split("/").pop()}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// Memoized single message — prevents re-parsing markdown when streaming/status changes
const MessageItem = memo(({ msg, onOpenOutput }: { msg: Message; onOpenOutput: () => void }) => (
  <div className={`message ${msg.role}`}>
    <div className="message-avatar">{msg.role === "user" ? "U" : "C"}</div>
    <div className="message-content">
      {msg.role === "assistant" ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{msg.content}</ReactMarkdown>
      ) : (
        <>
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="message-attachments">
              {msg.attachments.map((f, j) => (
                <div key={j} className="attachment-item">
                  {isImageFile(f.name) ? (
                    <img src={sandboxUrl(f.path)} alt={f.name} className="attachment-image-preview" />
                  ) : (
                    <div className="attachment-icon">{getFileIcon(f.name)}</div>
                  )}
                  <div className="attachment-info">
                    <span className="attachment-name">{f.name}</span>
                    <span className="attachment-size">{formatFileSize(f.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p>{msg.content.replace(/\[Attached file:.*?\]/g, "").trim()}</p>
        </>
      )}
      {msg.files && msg.files.length > 0 && (
        <div className="message-output-indicator" onClick={onOpenOutput}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
          {msg.files.length} output{msg.files.length > 1 ? "s" : ""} — view in panel
        </div>
      )}
    </div>
  </div>
));

// Memoized message list — isolates from streaming/status re-renders
const MessageList = memo(({ messages, onOpenOutput }: { messages: Message[]; onOpenOutput: () => void }) => (
  <>
    {messages.map((msg, i) => (
      <MessageItem key={i} msg={msg} onOpenOutput={onOpenOutput} />
    ))}
  </>
));

// Lightweight streaming renderer — uses dangerouslySetInnerHTML with simple HTML conversion
// instead of full ReactMarkdown parsing. ReactMarkdown is too expensive at 7 renders/sec
// and causes browser hangs during swarm activity.
const STREAM_RENDER_LIMIT = 3000;
function streamToHtml(text: string): string {
  // Minimal markdown-like conversion: bold, inline code, blockquotes, links, line breaks
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
}
const StreamingMessage = memo(({ content }: { content: string }) => {
  if (!content) return null;
  let displayContent = content;
  if (content.length > STREAM_RENDER_LIMIT) {
    const cutIdx = content.lastIndexOf("\n", content.length - STREAM_RENDER_LIMIT);
    const trimFrom = cutIdx > 0 ? cutIdx + 1 : content.length - STREAM_RENDER_LIMIT;
    displayContent = `... ${Math.floor(trimFrom / 1000)}K chars above ...\n\n` + content.slice(trimFrom);
  }
  return (
    <div className="message assistant">
      <div className="message-avatar">C</div>
      <div className="message-content">
        <div dangerouslySetInnerHTML={{ __html: streamToHtml(displayContent) }} />
      </div>
    </div>
  );
});

export default function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const isLoading = runningTaskIds.size > 0;
  const [status, setStatus] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [outputPanelOpen, setOutputPanelOpen] = useState(true);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [activeTaskSessions, setActiveTaskSessions] = useState<Set<string>>(new Set());
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [activityLogContent, setActivityLogContent] = useState("");
  const activityLogRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { connected, sendMessage, onChunk, onResponse, onStatus } = useSocket();

  // ─── Throttled streaming: batch chunks to avoid re-rendering on every tiny chunk ───
  const streamBufferRef = useRef("");
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAM_FLUSH_MS = 350; // flush at most ~3 times/sec (was 150ms — too fast for swarm events)

  const STREAM_MAX_LEN = 8000; // cap streaming string to prevent O(n²) growth
  const flushStreamBuffer = useCallback(() => {
    streamFlushTimerRef.current = null;
    if (streamBufferRef.current) {
      const buf = streamBufferRef.current;
      streamBufferRef.current = "";
      setStreaming((prev) => {
        const next = prev + buf;
        // Trim from the front if too long — keep the most recent content
        if (next.length > STREAM_MAX_LEN) {
          const cutIdx = next.indexOf("\n", next.length - STREAM_MAX_LEN);
          return cutIdx > 0 ? next.slice(cutIdx + 1) : next.slice(next.length - STREAM_MAX_LEN);
        }
        return next;
      });
    }
  }, []);

  // ─── Throttled status: coalesce rapid status updates ───
  const pendingStatusRef = useRef<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STATUS_THROTTLE_MS = 200;

  const setThrottledStatus = useCallback((s: string) => {
    pendingStatusRef.current = s;
    if (!statusTimerRef.current) {
      statusTimerRef.current = setTimeout(() => {
        statusTimerRef.current = null;
        if (pendingStatusRef.current !== null) {
          setStatus(pendingStatusRef.current);
          pendingStatusRef.current = null;
        }
      }, STATUS_THROTTLE_MS);
    }
  }, []);

  // Collect all unique output files from messages for the right panel
  const allOutputFiles = useMemo(() => {
    const seen = new Set<string>();
    const groups: { files: string[]; msgIndex: number }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.files && msg.files.length > 0) {
        const uniqueFiles = msg.files.filter(f => {
          if (seen.has(f)) return false;
          seen.add(f);
          return true;
        });
        if (uniqueFiles.length > 0) {
          groups.push({ files: uniqueFiles, msgIndex: i });
        }
      }
    }
    return groups;
  }, [messages]);

  useEffect(() => {
    api.getSessions().then((s: Session[]) => {
      setSessions(s);
      // Auto-select session from URL ?session=<id>
      const sessionParam = searchParams.get("session");
      if (sessionParam && s.some((sess: Session) => sess.id === sessionParam)) {
        setActiveSession(sessionParam);
        setSearchParams({}, { replace: true }); // clean URL
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeSession) {
      api.getSession(activeSession).then((session: any) => {
        setMessages(session.messages || []);
      });
    }
  }, [activeSession]);

  const toolLabels: Record<string, string> = {
    web_search: "Searching the web",
    fetch_url: "Fetching URL",
    run_python: "Running Python",
    run_react: "Running React",
    run_shell: "Running command",
    read_file: "Reading file",
    write_file: "Writing file",
    list_files: "Listing files",
    list_skills: "Listing skills",
    load_skill: "Loading skill",
    clawhub_search: "Searching ClawHub",
    clawhub_install: "Installing skill",
    spawn_subagent: "Spawning sub-agent",
    send_task: "Delegating task",
    wait_result: "Waiting for agent",
    check_agents: "Checking agents",
    error_recovery: "Recovering from error",
    remote_task: "Remote task",
    remote_progress: "Remote agent working",
  };

  // Restore in-progress state on mount, reconnect, or session switch
  // Track whether we previously saw an active task so we can detect completion
  const wasLoadingRef = useRef(false);
  const missCountRef = useRef(0); // require multiple consecutive misses before treating as done
  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;

    const checkActiveTasks = () => {
      api.getActiveTasks().then((tasks: any[]) => {
        if (cancelled) return;
        // Track all sessions with active tasks for sidebar indicators
        // Use API as additive source — only "done" status events should remove sessions.
        // This prevents a race where the HTTP poll response arrives after a WebSocket
        // status event, overwriting sessions that were just added by real-time events.
        const apiSessions = new Set(tasks.map((t: any) => t.sessionId).filter(Boolean));
        setActiveTaskSessions((prev) => {
          const merged = new Set(prev);
          for (const s of apiSessions) merged.add(s);
          // If identical, skip re-render
          if (merged.size === prev.size) return prev;
          return merged;
        });
        // Track running tasks by ID for this session
        const sessionTasks = tasks.filter((t: any) => t.sessionId === activeSession);
        const sessionTaskIds = new Set(sessionTasks.map((t: any) => t.id as string));
        setRunningTaskIds((prev) => {
          if (prev.size === sessionTaskIds.size && [...prev].every(id => sessionTaskIds.has(id))) return prev;
          return sessionTaskIds;
        });
        const activeTask = sessionTasks[sessionTasks.length - 1]; // show status of most recent task
        if (activeTask) {
          wasLoadingRef.current = true;
          missCountRef.current = 0;
          if (activeTask.status.startsWith("Running:")) {
            const rawTool = activeTask.status.replace("Running: ", "");
            const tool = rawTool.split(" — ")[0]; // extract tool name before description
            const detail = rawTool.includes(" — ") ? rawTool.split(" — ")[1] : "";
            if (tool === "wait_result" && detail) {
              setStatus(`Waiting for ${detail}...`);
            } else if (tool === "send_task" && detail) {
              setStatus(`${detail}...`);
            } else {
              const label = toolLabels[tool] || tool;
              setStatus(`${label}...`);
            }
          } else if (activeTask.status.startsWith("Waiting for ") || activeTask.status.includes("done, thinking") || activeTask.status.includes("orchestrating") || activeTask.status.includes("received")) {
            setStatus(activeTask.status);
          } else {
            setStatus("Thinking...");
          }
        } else if (wasLoadingRef.current) {
          // Task was active before but is now gone — require 2 consecutive misses
          // to avoid clearing state on transient network blips
          missCountRef.current++;
          if (missCountRef.current >= 2) {
            // Task is truly done — the chat:response event was likely missed
            // Reset loading state and refresh messages to show the result
            wasLoadingRef.current = false;
            missCountRef.current = 0;
            setRunningTaskIds(new Set());
            setStreaming("");
            setStatus("");
            api.getSession(activeSession).then((session: any) => {
              if (!cancelled) setMessages(session.messages || []);
            });
          }
        }
      }).catch(() => {});
    };

    checkActiveTasks();

    // Poll every 3 seconds to keep status fresh and detect missed completions
    const interval = setInterval(() => {
      if (!cancelled) checkActiveTasks();
    }, 3000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [activeSession, connected]);

  useEffect(() => {
    const unsub1 = onChunk((data: any) => {
      if (data.sessionId === activeSession) {
        if (data.clear) {
          streamBufferRef.current = "";
          if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
          setStreaming("");
        } else {
          // Buffer chunks and flush periodically to avoid re-rendering on every tiny chunk
          streamBufferRef.current += data.content;
          if (!streamFlushTimerRef.current) {
            streamFlushTimerRef.current = setTimeout(flushStreamBuffer, STREAM_FLUSH_MS);
          }
        }
      }
    });
    const unsub2 = onResponse((data) => {
      if (data.sessionId !== activeSession) return;
      if (data.done === false) {
        // Progress flush — just refresh messages to show saved activity logs.
        // Do NOT clear streaming/status — the task is still running.
        api.getSession(activeSession).then((session: any) => {
          setMessages(session.messages || []);
        });
        return;
      }
      // Final response — refresh messages + clear streaming state
      wasLoadingRef.current = false;
      api.getSession(activeSession).then((session: any) => {
        setMessages(session.messages || []);
      });
      streamBufferRef.current = "";
      if (streamFlushTimerRef.current) { clearTimeout(streamFlushTimerRef.current); streamFlushTimerRef.current = null; }
      setStreaming("");
      setRunningTaskIds((prev) => {
        if (prev.size === 0) return prev;
        if (prev.size === 1) return new Set();
        return prev;
      });
      setStatus("");
    });
    const unsub3 = onStatus((data: any) => {
      // Track active task sessions for sidebar indicators
      if (data.sessionId && (data.status === "thinking" || data.status === "tool_call" || data.status === "running_python" || data.status === "retrying" || data.status === "realtime_agent_working" || data.status === "realtime_agent_tool" || (data.status === "running" && data.content && data.label))) {
        setActiveTaskSessions((prev) => {
          if (prev.has(data.sessionId)) return prev;
          const next = new Set(prev);
          next.add(data.sessionId);
          return next;
        });
      }

      // Only update loading/status UI for active session
      if (data.sessionId && data.sessionId !== activeSession) return;

      if (data.status === "thinking") {
        setThrottledStatus("Thinking...");
      } else if (data.status === "running_python") {
        setThrottledStatus("Running Python...");
      } else if (data.status === "tool_call") {
        const label = toolLabels[data.tool] || data.tool;
        if (data.tool === "send_task" && data.args) {
          const target = data.args.to || "agent";
          const taskPreview = data.args.task ? ` — ${data.args.task.slice(0, 60)}` : "";
          setThrottledStatus(`Delegating to ${target}${taskPreview}...`);
        } else if (data.tool === "wait_result" && data.args) {
          setThrottledStatus(`Waiting for ${data.args.from || "agent"} to finish...`);
        } else {
          setThrottledStatus(`${label}...`);
        }
      } else if (data.status === "tool_result") {
        const label = toolLabels[data.tool] || data.tool;
        if (data.tool === "wait_result") {
          setThrottledStatus("Agent result received, thinking...");
        } else if (data.tool === "send_task") {
          setThrottledStatus("Task delegated, orchestrating...");
        } else {
          setThrottledStatus(`${label} done, thinking...`);
        }
      } else if (data.status === "subagent_spawn") {
        setThrottledStatus(`Sub-agent "${data.label}" spawned...`);
      } else if (data.status === "subagent_tool") {
        if (data.tool === "remote_progress" && data.content) {
          setThrottledStatus(`Remote "${data.label}": ${data.content.slice(0, 100)}`);
        } else if (data.tool === "remote_task") {
          setThrottledStatus(`Sub-agent "${data.label}": delegating to remote...`);
        } else {
          const label = toolLabels[data.tool] || data.tool;
          setThrottledStatus(`Sub-agent "${data.label}": ${label}...`);
        }
      } else if (data.status === "subagent_tool_done") {
        // silent — keep current status
      } else if (data.status === "subagent_done") {
        setThrottledStatus(`Sub-agent "${data.label}" completed`);
      } else if (data.status === "subagent_error") {
        setThrottledStatus(`Sub-agent "${data.label}" failed: ${data.error}`);
      // ─── Realtime Agent status ───
      } else if (data.status === "realtime_agent_ready") {
        setThrottledStatus(`Agent "${data.label}" (${data.role}) ready`);
      } else if (data.status === "realtime_agent_working") {
        setThrottledStatus(`Agent "${data.label}" working — ${(data.task || "").slice(0, 80)}`);
      } else if (data.status === "realtime_agent_tool") {
        const label = data.tool === "error_recovery"
          ? "recovering from error"
          : toolLabels[data.tool] || data.tool;
        setThrottledStatus(`Agent "${data.label}": ${label}...`);
      } else if (data.status === "realtime_agent_tool_done") {
        // silent — keep current status
      } else if (data.status === "realtime_agent_done") {
        setThrottledStatus(`Agent "${data.label}" completed`);
      } else if (data.status === "running" && data.content && data.label) {
        setThrottledStatus(`Remote "${data.label}": ${data.content.slice(0, 100)}`);
      } else if (data.status === "retrying") {
        setThrottledStatus(`Retrying (${data.attempt}/${data.maxRetries})...`);
      } else if (data.status === "job_complete") {
        // Orchestrator finished — refresh messages and output files
        if (data.sessionId === activeSession && activeSession) {
          api.getSession(activeSession).then((session: any) => {
            setMessages(session.messages || []);
            setOutputPanelOpen(true); // auto-open output panel if files exist
          });
          setStatus("Job complete");
          setTimeout(() => setStatus(""), 3000);
        }
      } else if (data.status === "done") {
        // Clear active dot for this session
        if (data.sessionId) {
          setActiveTaskSessions((prev) => {
            const next = new Set(prev);
            next.delete(data.sessionId);
            return next;
          });
        }
        setRunningTaskIds((prev) => prev.size === 0 ? prev : new Set());
        setStatus("");
      } else if (typeof data.status === "string" && data.status.startsWith("Waiting for ")) {
        // "Waiting for agentName..." from late-result monitor — show it
        setThrottledStatus(data.status);
      } else {
        // Unknown status — ignore silently instead of clearing status
        // (clearing status on every unrecognized event caused render thrashing)
      }
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [activeSession, onChunk, onResponse, onStatus]);

  // ─── Activity log polling: fetch log file when panel is open ───
  useEffect(() => {
    if (!showActivityLog || !activeSession) { setActivityLogContent(""); return; }
    let cancelled = false;
    const fetchLog = () => {
      api.getActivityLog(activeSession).then((res: any) => {
        if (!cancelled && res.content) {
          setActivityLogContent(res.content);
          // Auto-scroll activity log to bottom
          setTimeout(() => activityLogRef.current?.scrollTo(0, activityLogRef.current.scrollHeight), 50);
        }
      }).catch(() => {});
    };
    fetchLog();
    const iv = setInterval(fetchLog, isLoading ? 2000 : 5000); // faster poll while task running
    return () => { cancelled = true; clearInterval(iv); };
  }, [showActivityLog, activeSession, isLoading]);

  // Throttled scroll — avoid expensive DOM layout on every chunk
  // Use interval-based scroll instead of effect-on-streaming to prevent re-renders every 150ms
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMessagesLenRef = useRef(0);
  useEffect(() => {
    // Scroll on new messages
    if (messages.length !== prevMessagesLenRef.current) {
      prevMessagesLenRef.current = messages.length;
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);
  // During streaming, scroll on a fixed interval instead of every state change
  useEffect(() => {
    if (!streaming) return;
    const iv = setInterval(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 500);
    return () => clearInterval(iv);
  }, [!!streaming]); // only re-run when streaming starts/stops, not on content changes

  const createNewSession = async () => {
    const session = await api.createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveSession(session.id);
    setMessages([]);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const result = await api.chatUpload(Array.from(files));
      if (result.success && result.files) {
        setAttachedFiles((prev) => [...prev, ...result.files]);
      }
    } catch (err) {
      console.error("Upload failed:", err);
    }
    setUploading(false);
    // Reset input so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSend = useCallback(() => {
    if (!input.trim() && attachedFiles.length === 0) return;

    // Separate image attachments for multimodal API payload
    const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    const imageAttachments = attachedFiles.filter((f) => imageExts.includes(getFileExt(f.name)));
    const nonImageAttachments = attachedFiles.filter((f) => !imageExts.includes(getFileExt(f.name)));

    // Build message with non-image attachment info
    let msg = input.trim();
    if (nonImageAttachments.length > 0) {
      const fileInfo = nonImageAttachments.map((f) => `[Attached file: ${f.name} (${f.type}, ${formatFileSize(f.size)}) saved at: ${f.path}]`).join("\n");
      msg = msg ? `${msg}\n\n${fileInfo}` : fileInfo;
    }
    // Add image file info as text context (the actual image is sent via multimodal payload)
    if (imageAttachments.length > 0) {
      const imgInfo = imageAttachments.map((f) => `[Image attached: ${f.name}]`).join("\n");
      msg = msg ? `${msg}\n\n${imgInfo}` : `What's in this image?\n\n${imgInfo}`;
    }

    // Build images payload for multimodal API
    const images = imageAttachments.map((f) => ({ path: f.path, type: f.type }));

    const userMessage: Message = {
      role: "user",
      content: msg,
      timestamp: new Date().toISOString(),
      attachments: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    };

    setInput("");
    setAttachedFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    if (!activeSession) {
      const title = input.trim().slice(0, 50) || attachedFiles[0]?.name || "File upload";
      api.createSession(title).then((session: any) => {
        setSessions((prev) => [session, ...prev]);
        setActiveSession(session.id);
        setMessages([userMessage]);
        setRunningTaskIds((prev) => new Set([...prev, "pending-" + Date.now()]));
        sendMessage(session.id, msg, images.length > 0 ? images : undefined);
      });
    } else {
      setMessages((prev) => [...prev, userMessage]);
      setRunningTaskIds((prev) => new Set([...prev, "pending-" + Date.now()]));
      sendMessage(activeSession, msg, images.length > 0 ? images : undefined);
    }
  }, [input, activeSession, sendMessage, attachedFiles]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const result = await api.chatUpload(Array.from(files));
      if (result.success && result.files) {
        setAttachedFiles((prev) => [...prev, ...result.files]);
      }
    } catch (err) {
      console.error("Drop upload failed:", err);
    }
    setUploading(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSession === id) {
      setActiveSession(null);
      setMessages([]);
    }
  };

  return (
    <div className="chat-page">
      <div className={`chat-sidebar-backdrop ${mobileSidebar ? "visible" : ""}`} onClick={() => setMobileSidebar(false)} />
      <div className={`chat-sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
        <button className="btn btn-primary new-chat-btn" onClick={() => { createNewSession(); setMobileSidebar(false); }}>
          <Icon name="add" /> New chat
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${activeSession === s.id ? "active" : ""}`}
              onClick={() => { setActiveSession(s.id); setMobileSidebar(false); }}
            >
              {activeTaskSessions.has(s.id) && <span className="session-running-indicator" title="Task running" />}
              <span className="session-title">{s.title}</span>
              <button className="session-delete btn-icon btn-ghost" onClick={(e) => deleteSession(s.id, e)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-main" onDrop={handleDrop} onDragOver={handleDragOver}>
        <div className="chat-top-bar">
          <button className="mobile-sessions-toggle" onClick={() => setMobileSidebar(true)}>
            <Icon name="chat" />
            <span>{activeSession ? sessions.find(s => s.id === activeSession)?.title || "Chat" : "Sessions"}</span>
          </button>
          <button
            className={`activity-log-toggle ${showActivityLog ? "active" : ""}`}
            onClick={() => setShowActivityLog(v => !v)}
            title={showActivityLog ? "Hide activity log" : "Show activity log"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>Activity</span>
          </button>
        </div>
        {!activeSession && messages.length === 0 ? (
          <div className="chat-empty">
            <h1>TigrimOS</h1>
            <p style={{ fontSize: 12, opacity: 0.4, marginTop: -8, marginBottom: 8 }}>v1.1.1</p>
            <p>Start a conversation to get help with coding, run Python, manage files, and more.</p>
            <div className="chat-suggestions">
              {["Write a Python script to generate a PDF report", "Help me analyze a CSV file", "Build a React dashboard with charts", "Create a web scraper"].map((s) => (
                <button key={s} className="suggestion-chip" onClick={() => { setInput(s); textareaRef.current?.focus(); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {showActivityLog && (
              <div className="activity-log-panel">
                <div className="activity-log-header">
                  <span>Activity Log</span>
                  {isLoading && <span className="activity-log-live">LIVE</span>}
                </div>
                <div className="activity-log-body" ref={activityLogRef}>
                  {activityLogContent ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{activityLogContent}</ReactMarkdown>
                  ) : (
                    <div className="activity-log-empty">No activity yet. Run a task with agents to see logs here.</div>
                  )}
                </div>
              </div>
            )}
            <div className="chat-messages">
              <MessageList messages={messages} onOpenOutput={() => setOutputPanelOpen(true)} />
              <StreamingMessage content={streaming} />
              {status && <div className="chat-status">{status}</div>}
              <div ref={messagesEndRef} />
            </div>
          </>
        )}

        <div className="chat-input-container">
          {/* Attached files preview */}
          {attachedFiles.length > 0 && (
            <div className="attachments-preview">
              {attachedFiles.map((f, i) => (
                <div key={i} className="attachment-preview-item">
                  {isImageFile(f.name) ? (
                    <img src={sandboxUrl(f.path)} alt={f.name} className="attachment-thumb" />
                  ) : (
                    <div className="attachment-preview-icon">{getFileIcon(f.name)}</div>
                  )}
                  <span className="attachment-preview-name">{f.name}</span>
                  <button className="attachment-remove" onClick={() => removeAttachment(i)}>&times;</button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-input-wrapper">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.json,.xml,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.py,.js,.ts,.html,.css,.md,.yaml,.yml,.zip,.tar,.gz"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <button
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach files (PDF, images, documents, code)"
            >
              {uploading ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="spin">
                  <path d="M12 4V2C6.48 2 2 6.48 2 12h2c0-4.42 3.58-8 8-8z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
                </svg>
              )}
            </button>
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="Message TigrimOS..."
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={false}
            />
            <button
              className={`send-btn ${input.trim() || attachedFiles.length > 0 ? "active" : ""}`}
              onClick={handleSend}
              disabled={!input.trim() && attachedFiles.length === 0}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
          <div className="chat-input-hint">
            {connected ? "Connected" : "Disconnected"}{runningTaskIds.size > 1 ? ` · ${runningTaskIds.size} tasks running` : runningTaskIds.size === 1 ? " · 1 task running" : ""} · Attach files with the clip icon or drag & drop · Press Enter to send
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
            {allOutputFiles.map((group) => (
              <OutputCanvas key={group.files.join(",")} files={group.files} />
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
  );
}
