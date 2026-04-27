import { useState, useEffect, useRef } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

interface Mount {
  id: string;
  label: string;
  path: string;
  permissions: "read" | "readwrite";
  source?: string; // "9p", "virtiofs", etc. — indicates host-shared folder
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
}

export default function LocalFilesPage() {
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [activeMount, setActiveMount] = useState<Mount | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [newFileName, setNewFileName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [showNewDir, setShowNewDir] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Add mount form
  const [showAddMount, setShowAddMount] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addPermissions, setAddPermissions] = useState<"read" | "readwrite">("readwrite");
  const [addError, setAddError] = useState("");
  const [addValidating, setAddValidating] = useState(false);

  // Auto-detected VM shared folders
  const [detectedShares, setDetectedShares] = useState<Array<{ path: string; label: string; source: string; permissions?: "read" | "readwrite" }>>([]);
  const [detectLoading, setDetectLoading] = useState(false);

  const codeExts = [".py", ".json", ".csv", ".js", ".ts", ".tsx", ".jsx", ".yaml", ".yml", ".sh", ".bash", ".sql", ".r", ".m", ".txt", ".md", ".html", ".css", ".xml", ".cfg", ".ini", ".toml", ".env", ".log"];
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];

  // Load mounts and auto-register detected VM shares
  useEffect(() => {
    loadMountsAndSync();
  }, []);

  const loadMountsAndSync = async () => {
    setDetectLoading(true);
    try {
      // Load existing mounts
      const currentMounts = await api.getLocalMounts();
      setMounts(currentMounts || []);

      // Detect VM shared folders
      const shares = await api.detectSharedFolders();
      setDetectedShares(shares || []);

      // Auto-register new shares and update labels/permissions for existing ones
      if (shares && shares.length > 0) {
        const settings = await api.getSettings();
        const existing = settings.localFileMounts || [];
        let changed = false;
        for (const share of shares) {
          const found = existing.find((m: any) => m.path === share.path);
          if (!found) {
            // New share — register it
            existing.push({
              id: "mount-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
              path: share.path,
              label: share.label,
              permissions: (share.permissions || "readwrite") as "read" | "readwrite",
              source: share.source,
              enabled: true,
            });
            changed = true;
          } else {
            // Existing mount — update label if detected name is better (not shared-N)
            if (share.label !== found.label && !/^shared-\d+$/.test(share.label)) {
              found.label = share.label;
              changed = true;
            }
            // Sync permissions from actual mount
            if (share.permissions && share.permissions !== found.permissions) {
              found.permissions = share.permissions;
              changed = true;
            }
          }
        }
        if (changed) {
          await api.saveSettings({ ...settings, localFileMounts: existing });
          const refreshed = await api.getLocalMounts();
          setMounts(refreshed || []);
        }
      }
    } catch {}
    setDetectLoading(false);
  };

  const loadMounts = async () => {
    try {
      const m = await api.getLocalMounts();
      setMounts(m || []);
    } catch {
      setMounts([]);
    }
  };

  const detectShares = async () => {
    setDetectLoading(true);
    try {
      const shares = await api.detectSharedFolders();
      setDetectedShares(shares || []);

      // Auto-register new ones and update labels/permissions
      if (shares && shares.length > 0) {
        const settings = await api.getSettings();
        const existing = settings.localFileMounts || [];
        let changed = false;
        for (const share of shares) {
          const found = existing.find((m: any) => m.path === share.path);
          if (!found) {
            existing.push({
              id: "mount-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
              path: share.path,
              label: share.label,
              permissions: (share.permissions || "readwrite") as "read" | "readwrite",
              source: share.source,
              enabled: true,
            });
            changed = true;
          } else {
            if (share.label !== found.label && !/^shared-\d+$/.test(share.label)) {
              found.label = share.label;
              changed = true;
            }
            if (share.permissions && share.permissions !== found.permissions) {
              found.permissions = share.permissions;
              changed = true;
            }
          }
        }
        if (changed) {
          await api.saveSettings({ ...settings, localFileMounts: existing });
          await loadMounts();
        }
      }
    } catch {
      setDetectedShares([]);
    }
    setDetectLoading(false);
  };

  const connectDetectedShare = async (share: { path: string; label: string; source: string; permissions?: "read" | "readwrite" }) => {
    try {
      const settings = await api.getSettings();
      const existing = settings.localFileMounts || [];
      // Don't duplicate
      if (existing.some((m: any) => m.path === share.path && m.enabled)) return;
      const id = "mount-" + Date.now();
      existing.push({ id, path: share.path, label: share.label, permissions: share.permissions || "readwrite", enabled: true });
      await api.saveSettings({ ...settings, localFileMounts: existing });
      await loadMounts();
      // Auto-select it
      const refreshed = await api.getLocalMounts();
      const newMount = refreshed.find((m: Mount) => m.path === share.path);
      if (newMount) selectMount(newMount);
    } catch (err: any) {
      alert("Failed to connect: " + (err.message || "unknown error"));
    }
  };

  const browseDir = async (mount: Mount, subPath: string) => {
    setLoading(true);
    try {
      const entries = await api.browseLocalFiles(mount.id, subPath);
      const sorted = (entries || []).sort((a: FileEntry, b: FileEntry) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sorted);
      setSelectedFiles(new Set());
    } catch (err: any) {
      setFiles([]);
    }
    setLoading(false);
  };

  const selectMount = async (mount: Mount) => {
    setActiveMount(mount);
    setCurrentPath("");
    setSelectedFile(null);
    setFileContent("");
    setEditing(false);
    await browseDir(mount, "");
  };

  const navigateInto = async (entry: FileEntry) => {
    if (!entry.isDirectory || !activeMount) return;
    const newPath = entry.path;
    setCurrentPath(newPath);
    setSelectedFile(null);
    setFileContent("");
    setEditing(false);
    await browseDir(activeMount, newPath);
  };

  const goUp = async () => {
    if (!activeMount) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const newPath = parts.join("/");
    setCurrentPath(newPath);
    setSelectedFile(null);
    setFileContent("");
    setEditing(false);
    await browseDir(activeMount, newPath);
  };

  const navigateToBreadcrumb = async (index: number) => {
    if (!activeMount) return;
    const parts = currentPath.split("/").filter(Boolean);
    const newPath = index < 0 ? "" : parts.slice(0, index + 1).join("/");
    setCurrentPath(newPath);
    setSelectedFile(null);
    setFileContent("");
    setEditing(false);
    await browseDir(activeMount, newPath);
  };

  const openFile = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      await navigateInto(entry);
      return;
    }
    if (!activeMount) return;
    try {
      const ext = entry.name.substring(entry.name.lastIndexOf(".")).toLowerCase();
      if (imageExts.includes(ext)) {
        // Use download URL for images
        setSelectedFile(entry.name);
        setFileContent(api.localDownloadUrl(activeMount.id, entry.path));
        setEditing(false);
      } else {
        const res = await api.readLocalFile(activeMount.id, entry.path);
        setSelectedFile(entry.name);
        setFileContent(res.content || "");
        setEditing(false);
      }
    } catch (err: any) {
      setSelectedFile(entry.name);
      setFileContent(`[Unable to read file: ${err.message || "unknown error"}]`);
      setEditing(false);
    }
  };

  const saveFile = async () => {
    if (!selectedFile || !activeMount) return;
    const entry = files.find(f => f.name === selectedFile);
    if (!entry) return;
    try {
      await api.writeLocalFile(activeMount.id, entry.path, fileContent);
      setEditing(false);
    } catch (err: any) {
      alert("Save failed: " + (err.message || "Permission denied"));
    }
  };

  const createFile = async () => {
    if (!newFileName || !activeMount) return;
    const filePath = currentPath ? currentPath + "/" + newFileName : newFileName;
    try {
      await api.writeLocalFile(activeMount.id, filePath, "");
      setShowNew(false);
      setNewFileName("");
      await browseDir(activeMount, currentPath);
    } catch (err: any) {
      alert("Create failed: " + (err.message || "Permission denied"));
    }
  };

  const createDir = async () => {
    if (!newDirName || !activeMount) return;
    const dirPath = currentPath ? currentPath + "/" + newDirName : newDirName;
    try {
      await api.localMkdir(activeMount.id, dirPath);
      setShowNewDir(false);
      setNewDirName("");
      await browseDir(activeMount, currentPath);
    } catch (err: any) {
      alert("Mkdir failed: " + (err.message || "Permission denied"));
    }
  };

  const deleteSelected = async () => {
    if (!activeMount || selectedFiles.size === 0) return;
    if (!confirm(`Delete ${selectedFiles.size} item(s)?`)) return;
    for (const name of selectedFiles) {
      const entry = files.find(f => f.name === name);
      if (entry) {
        try {
          await api.deleteLocalFile(activeMount.id, entry.path);
        } catch (err: any) {
          console.error(`Failed to delete ${name}:`, err);
        }
      }
    }
    if (selectedFile && selectedFiles.has(selectedFile)) {
      setSelectedFile(null);
      setFileContent("");
    }
    setSelectedFiles(new Set());
    await browseDir(activeMount, currentPath);
  };

  const deleteFile = async (entry: FileEntry) => {
    if (!activeMount) return;
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      await api.deleteLocalFile(activeMount.id, entry.path);
      if (selectedFile === entry.name) {
        setSelectedFile(null);
        setFileContent("");
      }
      await browseDir(activeMount, currentPath);
    } catch (err: any) {
      alert("Delete failed: " + (err.message || "Permission denied"));
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    if (!activeMount) return;
    for (const file of Array.from(fileList)) {
      try {
        await api.uploadLocalFile(activeMount.id, file, currentPath);
      } catch (err: any) {
        console.error(`Upload ${file.name} failed:`, err);
      }
    }
    await browseDir(activeMount, currentPath);
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
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  };

  const toggleSelect = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map(f => f.name)));
    }
  };

  const addMount = async () => {
    if (!addPath.trim()) { setAddError("Path is required"); return; }
    setAddValidating(true);
    setAddError("");
    try {
      const validation = await api.validateLocalPath(addPath.trim());
      if (!validation.exists || !validation.isDirectory) {
        setAddError(validation.error || `Path does not exist or is not a directory (exists=${validation.exists}, isDir=${validation.isDirectory})`);
        setAddValidating(false);
        return;
      }

      // Save mount to settings
      const settings = await api.getSettings();
      const existing = settings.localFileMounts || [];
      const id = "mount-" + Date.now();
      const label = addLabel.trim() || addPath.trim().split("/").filter(Boolean).pop() || "Mount";
      existing.push({ id, path: validation.resolvedPath, label, permissions: addPermissions, enabled: true });
      await api.saveSettings({ ...settings, localFileMounts: existing });

      setShowAddMount(false);
      setAddPath("");
      setAddLabel("");
      setAddPermissions("readwrite");
      await loadMounts();
    } catch (err: any) {
      setAddError(err.message || "Failed to add mount");
    }
    setAddValidating(false);
  };

  const removeMount = async (mount: Mount) => {
    if (!confirm(`Remove mount "${mount.label}"?`)) return;
    try {
      const settings = await api.getSettings();
      settings.localFileMounts = (settings.localFileMounts || []).filter((m: any) => m.id !== mount.id);
      await api.saveSettings(settings);
      if (activeMount?.id === mount.id) {
        setActiveMount(null);
        setFiles([]);
        setCurrentPath("");
        setSelectedFile(null);
        setFileContent("");
      }
      await loadMounts();
    } catch (err: any) {
      alert("Failed to remove: " + err.message);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const ext = selectedFile ? selectedFile.substring(selectedFile.lastIndexOf(".")).toLowerCase() : "";
  const isCode = codeExts.includes(ext);
  const isImage = imageExts.includes(ext);
  const isReadOnly = activeMount?.permissions === "read";
  const pathParts = currentPath.split("/").filter(Boolean);

  // No active mount — show mount list / add form
  if (!activeMount) {
    return (
      <div className="page" style={{ padding: 24 }}>
        <h2>Local Files</h2>
        <p style={{ opacity: 0.7, marginBottom: 16 }}>
          Connect folders from your host machine so the agent can read, write, and run scripts on files outside the sandbox.
          {detectedShares.length > 0 ? " Shared folders from your VM host are detected below." : " Add a folder path or share folders from your VM host."}
        </p>

        {/* Auto-detected VM shared folders */}
        {detectedShares.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Detected Shared Folders</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {detectedShares.filter(s => !mounts.some(m => m.path === s.path)).map((share, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "rgba(52, 168, 83, 0.08)", borderRadius: 8, border: "1px solid rgba(52, 168, 83, 0.3)" }}>
                  <span style={{ fontSize: 18 }}>{"\uD83D\uDD17"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{share.label}</div>
                    <div style={{ fontSize: 12, opacity: 0.6 }}>{share.path}</div>
                    <div style={{ fontSize: 11, opacity: 0.5 }}>{share.source}</div>
                  </div>
                  <button className="btn btn-primary" onClick={() => connectDetectedShare(share)}>Connect</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {mounts.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>Connected Folders</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {mounts.map(m => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-secondary, #f6f8fa)", borderRadius: 8, border: "1px solid var(--border, #d0d7de)" }}>
                  <span style={{ fontSize: 18 }}>{"\uD83D\uDCC1"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                      {m.label}
                      {m.source && ["9p", "virtiofs", "vboxsf", "fuse.vmhgfs-fuse"].includes(m.source) && (
                        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#e8f5e9", color: "#2e7d32", fontWeight: 600 }}>Host</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.6 }}>{m.path}</div>
                    <div style={{ fontSize: 11, opacity: 0.5 }}>
                      {m.permissions === "readwrite" ? "Read & Write" : "Read Only"}
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={() => selectMount(m)}>Open</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeMount(m)} title="Remove mount" style={{ color: "#e57373" }}>&times;</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {showAddMount ? (
          <div style={{ padding: 16, background: "var(--bg-secondary, #f6f8fa)", borderRadius: 8, border: "1px solid var(--border, #d0d7de)", maxWidth: 500 }}>
            <h3 style={{ fontSize: 14, marginBottom: 12 }}>Add Folder</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Absolute path on your machine</label>
              <input
                type="text"
                value={addPath}
                onChange={e => setAddPath(e.target.value)}
                placeholder="/Users/you/projects/my-folder"
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border, #d0d7de)", boxSizing: "border-box", fontFamily: "monospace" }}
                onKeyDown={e => e.key === "Enter" && addMount()}
                autoFocus
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Label (optional)</label>
              <input
                type="text"
                value={addLabel}
                onChange={e => setAddLabel(e.target.value)}
                placeholder="My Project"
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border, #d0d7de)", boxSizing: "border-box" }}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Permissions</label>
              <select
                value={addPermissions}
                onChange={e => setAddPermissions(e.target.value as "read" | "readwrite")}
                style={{ padding: "6px 10px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border, #d0d7de)" }}
              >
                <option value="readwrite">Read & Write</option>
                <option value="read">Read Only</option>
              </select>
            </div>
            {addError && <div style={{ color: "#e57373", fontSize: 12, marginBottom: 8 }}>{addError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={addMount} disabled={addValidating}>
                {addValidating ? "Validating..." : "Connect Folder"}
              </button>
              <button className="btn btn-ghost" onClick={() => { setShowAddMount(false); setAddError(""); setAddPath(""); setAddLabel(""); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={() => setShowAddMount(true)}>
              + Add Folder
            </button>
            <button className="btn btn-secondary" onClick={detectShares} disabled={detectLoading}>
              {detectLoading ? "Scanning..." : "Scan for Shared Folders"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Active mount — file browser
  return (
    <div className="page-split">
      <div
        className="panel"
        style={!selectedFile ? { maxWidth: "none" } : undefined}
        onDrop={handleDrop}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
        onDragLeave={e => { e.preventDefault(); e.stopPropagation(); }}
      >
        <div className="panel-header">
          <h2>Local Files</h2>
          <div className="panel-actions">
            <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFileSelect} />
            {files.length > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13, opacity: 0.8 }}>
                <input type="checkbox" checked={selectedFiles.size === files.length && files.length > 0} onChange={selectAll} style={{ cursor: "pointer" }} />
                All
              </label>
            )}
            {selectedFiles.size > 0 && !isReadOnly && (
              <button className="btn btn-secondary" onClick={deleteSelected} style={{ color: "#e57373" }}>
                Delete ({selectedFiles.size})
              </button>
            )}
            {!isReadOnly && (
              <>
                <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>Upload</button>
                <button className="btn btn-secondary" onClick={() => setShowNewDir(true)}>Mkdir</button>
                <button className="btn btn-secondary" onClick={() => setShowNew(true)}>New file</button>
              </>
            )}
            <button className="btn btn-secondary" onClick={() => { setActiveMount(null); setFiles([]); setCurrentPath(""); setSelectedFile(null); }}>
              All Mounts
            </button>
          </div>
        </div>

        {/* Mount selector */}
        <div style={{ padding: "8px 12px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
          {mounts.map(m => (
            <button
              key={m.id}
              className={`btn ${activeMount.id === m.id ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: 12, padding: "4px 10px", display: "inline-flex", alignItems: "center", gap: 4 }}
              onClick={() => selectMount(m)}
            >
              {m.label}
              {m.source && ["9p", "virtiofs", "vboxsf", "fuse.vmhgfs-fuse"].includes(m.source) && (
                <span style={{ fontSize: 9, padding: "0 4px", borderRadius: 3, background: activeMount.id === m.id ? "rgba(255,255,255,0.3)" : "#e8f5e9", color: activeMount.id === m.id ? "#fff" : "#2e7d32", fontWeight: 700 }}>Host</span>
              )}
            </button>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => { setActiveMount(null); setShowAddMount(true); }} title="Add folder" style={{ fontSize: 16, padding: "2px 8px" }}>+</button>
          {isReadOnly && <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 4 }}>read-only</span>}
          {activeMount.source && ["9p", "virtiofs", "vboxsf", "fuse.vmhgfs-fuse"].includes(activeMount.source) && (
            <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "#e8f5e9", color: "#2e7d32", fontWeight: 600, marginLeft: 4 }}>Host Folder</span>
          )}
        </div>

        {/* Breadcrumb */}
        <div className="breadcrumb">
          <button className="breadcrumb-item" onClick={() => navigateToBreadcrumb(-1)}>
            {activeMount.label}
          </button>
          {pathParts.map((part, i) => (
            <span key={i}>
              <span className="breadcrumb-sep">/</span>
              <button className="breadcrumb-item" onClick={() => navigateToBreadcrumb(i)}>
                {part}
              </button>
            </span>
          ))}
        </div>

        {showNewDir && !isReadOnly && (
          <div className="inline-form">
            <input placeholder="folder-name" value={newDirName} onChange={e => setNewDirName(e.target.value)} onKeyDown={e => e.key === "Enter" && createDir()} autoFocus />
            <button className="btn btn-primary" onClick={createDir}>Create</button>
            <button className="btn btn-ghost" onClick={() => { setShowNewDir(false); setNewDirName(""); }}>Cancel</button>
          </div>
        )}

        {showNew && !isReadOnly && (
          <div className="inline-form">
            <input placeholder="filename.txt" value={newFileName} onChange={e => setNewFileName(e.target.value)} onKeyDown={e => e.key === "Enter" && createFile()} autoFocus />
            <button className="btn btn-primary" onClick={createFile}>Create</button>
            <button className="btn btn-ghost" onClick={() => { setShowNew(false); setNewFileName(""); }}>Cancel</button>
          </div>
        )}

        {currentPath && (
          <div className="file-item" onClick={goUp}>
            <span className="file-icon">&uarr;</span>
            <span className="file-name">..</span>
          </div>
        )}

        <div className="file-list">
          {loading && <div className="empty-state">Loading...</div>}
          {!loading && files.map(file => (
            <div key={file.name} className={`file-item ${selectedFile === file.name ? "active" : ""}`} onClick={() => openFile(file)}>
              <input
                type="checkbox"
                checked={selectedFiles.has(file.name)}
                onClick={e => toggleSelect(file.name, e)}
                onChange={() => {}}
                style={{ cursor: "pointer", marginRight: 4, flexShrink: 0 }}
              />
              <span className="file-icon">{file.isDirectory ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
              <span className="file-name">{file.name}</span>
              <span className="file-size">{formatSize(file.size)}</span>
              {!isReadOnly && (
                <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); deleteFile(file); }}>&times;</button>
              )}
            </div>
          ))}
          {!loading && files.length === 0 && <div className="empty-state">No files</div>}
        </div>
      </div>

      {selectedFile && (
        <div className="panel editor-panel">
          <div className="panel-header">
            <h3>{selectedFile}</h3>
            <div className="panel-actions">
              {editing ? (
                <>
                  <button className="btn btn-primary" onClick={saveFile}>Save</button>
                  <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
                </>
              ) : !isImage && !isReadOnly ? (
                <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>
              ) : null}
            </div>
          </div>
          {isImage ? (
            <div className="file-preview" style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 16 }}>
              <img src={fileContent} alt={selectedFile} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
            </div>
          ) : editing ? (
            <textarea className="file-editor" value={fileContent} onChange={e => setFileContent(e.target.value)} />
          ) : isCode ? (
            <div className="file-preview rich-preview" style={{ overflow: "auto", position: "relative" }}>
              <div style={{ position: "absolute", top: 6, right: 10, fontSize: 11, opacity: 0.4 }}>{ext}</div>
              <pre style={{ margin: 0, padding: "8px 0", counterReset: "line" }}>{fileContent.split("\n").map((line, i) => (
                <div key={i} style={{ display: "flex", minHeight: 20 }}>
                  <span style={{ display: "inline-block", width: 45, textAlign: "right", paddingRight: 12, color: "rgba(255,255,255,0.25)", userSelect: "none", flexShrink: 0, fontSize: 12 }}>{i + 1}</span>
                  <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
                </div>
              ))}</pre>
            </div>
          ) : (
            <pre className="file-preview">{fileContent}</pre>
          )}
        </div>
      )}
    </div>
  );
}
