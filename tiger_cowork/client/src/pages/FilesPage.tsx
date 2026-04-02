import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { api, sandboxUrl } from "../utils/api";
import "./PageStyles.css";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
}

export default function FilesPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [showNewDir, setShowNewDir] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [richPreview, setRichPreview] = useState<{ type: string; html: string } | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleSelect = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map((f) => f.path)));
    }
  };

  const deleteSelected = async () => {
    if (selectedFiles.size === 0) return;
    if (!confirm(`Delete ${selectedFiles.size} item(s)?`)) return;
    for (const path of selectedFiles) {
      try { await api.deleteFile(path); } catch {}
    }
    if (selectedFile && selectedFiles.has(selectedFile)) {
      setSelectedFile(null);
      setFileContent("");
    }
    setSelectedFiles(new Set());
    loadFiles(currentPath);
  };

  useEffect(() => {
    loadFiles(currentPath);
    setSelectedFiles(new Set());
  }, [currentPath]);

  const loadFiles = async (path: string) => {
    const data = await api.listFiles(path);
    setFiles(data);
  };

  const richPreviewExts = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".md"];
  const codePreviewExts = [".py", ".json", ".csv", ".js", ".ts", ".tsx", ".jsx", ".yaml", ".yml", ".sh", ".bash", ".sql", ".r", ".m"];
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
  const mediaExts = [".mp4", ".webm", ".mp3", ".wav", ".ogg"];

  const openFile = async (file: FileEntry) => {
    if (file.isDirectory) {
      setCurrentPath(file.path);
      setSelectedFile(null);
      setRichPreview(null);
    } else {
      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if (imageExts.includes(ext)) {
        setSelectedFile(file.path);
        setFileContent("");
        setEditing(false);
        setRichPreview({ type: "image", html: "" });
      } else if (richPreviewExts.includes(ext)) {
        setSelectedFile(file.path);
        setFileContent("");
        setEditing(false);
        setRichPreview(null);
        try {
          const data = await api.previewFile(file.path);
          setRichPreview({ type: data.type, html: data.html });
        } catch {
          setRichPreview({ type: "error", html: "Preview unavailable" });
        }
      } else if (ext === ".html" || ext === ".htm") {
        setSelectedFile(file.path);
        setFileContent("");
        setEditing(false);
        setRichPreview({ type: "html", html: "" });
      } else if (mediaExts.includes(ext)) {
        setSelectedFile(file.path);
        setFileContent("");
        setEditing(false);
        const isVideo = [".mp4", ".webm"].includes(ext);
        setRichPreview({ type: isVideo ? "video" : "audio", html: "" });
      } else if (codePreviewExts.includes(ext)) {
        const data = await api.readFile(file.path);
        setSelectedFile(file.path);
        setFileContent(data.content);
        setEditing(false);
        setRichPreview({ type: ext === ".csv" ? "csv" : "code", html: ext });
      } else {
        const data = await api.readFile(file.path);
        setSelectedFile(file.path);
        setFileContent(data.content);
        setEditing(false);
        setRichPreview(null);
      }
    }
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    await api.writeFile(selectedFile, fileContent);
    setEditing(false);
  };

  const createFile = async () => {
    if (!newFileName) return;
    const filePath = currentPath ? `${currentPath}/${newFileName}` : newFileName;
    await api.writeFile(filePath, "");
    setShowNew(false);
    setNewFileName("");
    loadFiles(currentPath);
  };

  const createDir = async () => {
    if (!newDirName) return;
    const dirPath = currentPath ? `${currentPath}/${newDirName}` : newDirName;
    await api.mkdir(dirPath);
    setShowNewDir(false);
    setNewDirName("");
    loadFiles(currentPath);
  };

  const deleteFile = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    await api.deleteFile(path);
    if (selectedFile === path) {
      setSelectedFile(null);
      setFileContent("");
    }
    loadFiles(currentPath);
  };

  const goUp = () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join("/"));
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;
    setUploading(true);
    try {
      for (const file of filesArray) {
        await api.uploadFile(file, currentPath);
      }
      loadFiles(currentPath);
    } catch (err) {
      console.error("Upload failed:", err);
    }
    setUploading(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      uploadFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  return (
    <div className="page-split">
      <div
        className="panel"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="panel-header">
          <h2>Sandbox Files</h2>
          <div className="panel-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            {files.length > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13, opacity: 0.8 }}>
                <input
                  type="checkbox"
                  checked={selectedFiles.size === files.length && files.length > 0}
                  onChange={selectAll}
                  style={{ cursor: "pointer" }}
                />
                All
              </label>
            )}
            {selectedFiles.size > 0 && (
              <button className="btn btn-secondary" onClick={deleteSelected} style={{ color: "#e57373" }}>
                Delete ({selectedFiles.size})
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
            <button className="btn btn-secondary" onClick={() => setShowNewDir(true)}>Mkdir</button>
            <button className="btn btn-secondary" onClick={() => setShowNew(true)}>New file</button>
          </div>
        </div>

        <div className="breadcrumb">
          <button className="breadcrumb-item" onClick={() => setCurrentPath("")}>sandbox</button>
          {currentPath.split("/").filter(Boolean).map((part, i, arr) => (
            <span key={i}>
              <span className="breadcrumb-sep">/</span>
              <button className="breadcrumb-item" onClick={() => setCurrentPath(arr.slice(0, i + 1).join("/"))}>
                {part}
              </button>
            </span>
          ))}
        </div>

        {showNewDir && (
          <div className="inline-form">
            <input placeholder="folder-name" value={newDirName} onChange={(e) => setNewDirName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createDir()} autoFocus />
            <button className="btn btn-primary" onClick={createDir}>Create</button>
            <button className="btn btn-ghost" onClick={() => { setShowNewDir(false); setNewDirName(""); }}>Cancel</button>
          </div>
        )}

        {showNew && (
          <div className="inline-form">
            <input placeholder="filename.txt" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFile()} autoFocus />
            <button className="btn btn-primary" onClick={createFile}>Create</button>
            <button className="btn btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        )}

        {currentPath && (
          <div className="file-item" onClick={goUp}>
            <span className="file-icon">↑</span>
            <span className="file-name">..</span>
          </div>
        )}

        <div className="file-list">
          {files.map((file) => (
            <div key={file.name} className={`file-item ${selectedFile === file.path ? "active" : ""}`} onClick={() => openFile(file)}>
              <input
                type="checkbox"
                checked={selectedFiles.has(file.path)}
                onClick={(e) => toggleSelect(file.path, e)}
                onChange={() => {}}
                style={{ cursor: "pointer", marginRight: 4, flexShrink: 0 }}
              />
              <span className="file-icon">{file.isDirectory ? "📁" : "📄"}</span>
              <span className="file-name">{file.name}</span>
              <span className="file-size">{formatSize(file.size)}</span>
              <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); deleteFile(file.path); }}>×</button>
              {!file.isDirectory && (
                <a className="btn btn-ghost btn-sm" href={api.downloadUrl(file.path)} download onClick={(e) => e.stopPropagation()}>↓</a>
              )}
            </div>
          ))}
          {files.length === 0 && !dragOver && <div className="empty-state">No files yet</div>}
        </div>

        {/* Drag overlay */}
        {dragOver && (
          <div className="drop-overlay">
            <div className="drop-overlay-content">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
              </svg>
              <p>Drop files here to upload</p>
            </div>
          </div>
        )}
      </div>

      {selectedFile && (
        <div className="panel editor-panel">
          <div className="panel-header">
            <h3>{selectedFile}</h3>
            <div className="panel-actions">
              {richPreview && richPreview.type !== "code" && richPreview.type !== "csv" ? null : editing ? (
                <>
                  <button className="btn btn-primary" onClick={saveFile}>Save</button>
                  <button className="btn btn-ghost" onClick={() => { setEditing(false); if (richPreview) setRichPreview({ ...richPreview }); }}>Cancel</button>
                </>
              ) : (
                <button className="btn btn-secondary" onClick={() => { setRichPreview(null); setEditing(true); }}>Edit</button>
              )}
            </div>
          </div>
          {richPreview ? (
            richPreview.type === "image" && selectedFile ? (
              <div className="file-preview rich-preview" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src={sandboxUrl(selectedFile, true)} alt={selectedFile} style={{ maxWidth: "100%", maxHeight: "100%" }} />
              </div>
            ) : richPreview.type === "html" && selectedFile ? (
              <iframe src={sandboxUrl(selectedFile, true)} className="file-preview" style={{ border: "none", width: "100%", flex: 1, minHeight: 500 }} title={selectedFile} />
            ) : richPreview.type === "video" && selectedFile ? (
              <div className="file-preview rich-preview" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <video src={sandboxUrl(selectedFile)} controls style={{ maxWidth: "100%", maxHeight: "100%" }} />
              </div>
            ) : richPreview.type === "audio" && selectedFile ? (
              <div className="file-preview rich-preview" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <audio src={sandboxUrl(selectedFile)} controls />
              </div>
            ) : richPreview.type === "markdown" ? (
              <div className="file-preview rich-preview markdown-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{richPreview.html}</ReactMarkdown>
              </div>
            ) : richPreview.type === "csv" ? (
              <div className="file-preview rich-preview" style={{ overflow: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                  {fileContent.split("\n").filter(Boolean).map((row, ri) => {
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
                </table>
              </div>
            ) : richPreview.type === "code" ? (
              <div className="file-preview rich-preview" style={{ overflow: "auto", position: "relative" }}>
                <div style={{ position: "absolute", top: 6, right: 10, fontSize: 11, opacity: 0.4 }}>{richPreview.html}</div>
                <pre style={{ margin: 0, padding: "8px 0", counterReset: "line" }}>{fileContent.split("\n").map((line, i) => (
                  <div key={i} style={{ display: "flex", minHeight: 20 }}>
                    <span style={{ display: "inline-block", width: 45, textAlign: "right", paddingRight: 12, color: "rgba(255,255,255,0.25)", userSelect: "none", flexShrink: 0, fontSize: 12 }}>{i + 1}</span>
                    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
                  </div>
                ))}</pre>
              </div>
            ) : richPreview.type === "error" ? (
              <div className="file-preview rich-preview" style={{ color: "#e57373", padding: 24, textAlign: "center" }}>{richPreview.html}</div>
            ) : (
              <div className="file-preview rich-preview" dangerouslySetInnerHTML={{ __html: richPreview.html }} />
            )
          ) : editing ? (
            <textarea className="file-editor" value={fileContent} onChange={(e) => setFileContent(e.target.value)} />
          ) : (
            <pre className="file-preview">{fileContent}</pre>
          )}
        </div>
      )}
    </div>
  );
}
