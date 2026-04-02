import { ReactNode, useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "../utils/api";
import "./Layout.css";

const NAV_ITEMS = [
  { path: "/", label: "Chat", icon: "chat" },
  { path: "/projects", label: "Projects", icon: "project" },
  { path: "/files", label: "Files", icon: "folder" },
  { path: "/tasks", label: "Tasks", icon: "schedule" },
  { path: "/skills", label: "Skills", icon: "extension" },
  { path: "/settings", label: "Settings", icon: "settings" },
];

function Icon({ name }: { name: string }) {
  const icons: Record<string, string> = {
    chat: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z",
    folder: "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
    schedule: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z",
    extension: "M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v3.8h1.5c1.52 0 2.75 1.23 2.75 2.75S5.02 16.3 3.5 16.3H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.52 1.23-2.75 2.75-2.75s2.75 1.23 2.75 2.75V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z",
    settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
    project: "M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z",
    menu: "M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z",
    close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d={icons[name] || icons.chat} />
    </svg>
  );
}

export { Icon };

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

export default function Layout({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [swarmEnabled, setSwarmEnabled] = useState(false);
  const [agentMode, setAgentMode] = useState("");
  const [configFileName, setConfigFileName] = useState("");
  const [agentGroupName, setAgentGroupName] = useState("");
  const [agentConfigs, setAgentConfigs] = useState<any[]>([]);
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Check if sub-agent (swarm) mode is enabled & load agent configs
  useEffect(() => {
    api.getSettings().then((s: any) => {
      setSwarmEnabled(!!s.subAgentEnabled);
      setAgentMode(s.subAgentMode || "auto");
      setConfigFileName(s.subAgentConfigFile || "");
      // Load agent configs to resolve name and allow switching
      if (s.subAgentEnabled) {
        api.getAgentConfigs().then((configs: any[]) => {
          setAgentConfigs(configs);
          const current = configs.find((c: any) => c.filename === s.subAgentConfigFile);
          setAgentGroupName(current?.name || (s.subAgentConfigFile ? s.subAgentConfigFile.replace(/\.ya?ml$/, "") : ""));
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [location.pathname]);

  const switchAgentGroup = async (cfg: any) => {
    setShowAgentDropdown(false);
    setAgentGroupName(cfg.name);
    setConfigFileName(cfg.filename);
    const settings = await api.getSettings();
    await api.saveSettings({ ...settings, subAgentConfigFile: cfg.filename });
  };

  // Close sidebar on mobile when route changes
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [location.pathname, isMobile]);

  const handleNav = (path: string) => {
    navigate(path);
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <div className="layout">
      <header className="header">
        <button className="btn-icon btn-ghost" onClick={() => setSidebarOpen(!sidebarOpen)}>
          <Icon name={sidebarOpen ? "close" : "menu"} />
        </button>
        <div className="header-logo">
          <span className="logo-text">Tiger Cowork</span>
          <span className="logo-badge">AI</span>
          {swarmEnabled && agentMode === "realtime" && <span className="logo-realtime-tag">Realtime Agent</span>}
          {swarmEnabled && agentMode !== "realtime" && <span className="logo-swarm-tag">Swarm</span>}
          {swarmEnabled && agentGroupName && (
            <div className="agent-group-selector">
              <span
                className="logo-config-tag clickable"
                title={`Agent: ${agentGroupName} (${configFileName}) — click to change`}
                onClick={() => setShowAgentDropdown(!showAgentDropdown)}
              >
                {agentGroupName}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 4 }}>
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </span>
              {showAgentDropdown && (
                <>
                  <div className="agent-dropdown-backdrop" onClick={() => setShowAgentDropdown(false)} />
                  <div className="agent-dropdown">
                    <div className="agent-dropdown-title">Switch Agent Group</div>
                    {agentConfigs.map((cfg: any) => (
                      <div
                        key={cfg.filename}
                        className={`agent-dropdown-item ${cfg.filename === configFileName ? "active" : ""}`}
                        onClick={() => switchAgentGroup(cfg)}
                      >
                        <span className="agent-dropdown-name">{cfg.name}</span>
                        <span className="agent-dropdown-meta">{cfg.agentCount} agents</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="header-spacer" />
      </header>

      <div className="main-container">
        {sidebarOpen && isMobile && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}
        {sidebarOpen && (
          <nav className="sidebar">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.path}
                className={`nav-item ${location.pathname === item.path ? "active" : ""}`}
                onClick={() => handleNav(item.path)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        )}
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
