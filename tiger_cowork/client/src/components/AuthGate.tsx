import { useState, useEffect, ReactNode } from "react";
import { getAccessToken, setAccessToken } from "../utils/api";

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: getAccessToken() }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthed(true);
      } else {
        setAuthed(false);
      }
    } catch {
      setAuthed(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.ok) {
        setAccessToken(token);
        setAuthed(true);
      } else {
        setError("Invalid access token");
      }
    } catch {
      setError("Connection failed");
    }
  }

  if (authed === null) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "#0f172a" }}>
        <div style={{ color: "#94a3b8", fontSize: "1.1rem" }}>Loading...</div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div style={{
        display: "flex", justifyContent: "center", alignItems: "center",
        height: "100vh", background: "#0f172a",
      }}>
        <form onSubmit={handleSubmit} style={{
          background: "#1e293b", borderRadius: 12, padding: "2.5rem",
          minWidth: 340, boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}>
          <h2 style={{ color: "#f1f5f9", margin: "0 0 0.5rem", fontSize: "1.4rem" }}>
            Tiger Cowork
          </h2>
          <p style={{ color: "#64748b", margin: "0 0 1.5rem", fontSize: "0.9rem" }}>
            Enter access token to continue
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Access token"
            autoFocus
            style={{
              width: "100%", padding: "0.7rem 0.9rem", borderRadius: 8,
              border: "1px solid #334155", background: "#0f172a",
              color: "#f1f5f9", fontSize: "1rem", outline: "none",
              boxSizing: "border-box",
            }}
          />
          {error && (
            <div style={{ color: "#f87171", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {error}
            </div>
          )}
          <button type="submit" style={{
            width: "100%", marginTop: "1rem", padding: "0.7rem",
            borderRadius: 8, border: "none", background: "#3b82f6",
            color: "#fff", fontSize: "1rem", cursor: "pointer",
            fontWeight: 600,
          }}>
            Enter
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
