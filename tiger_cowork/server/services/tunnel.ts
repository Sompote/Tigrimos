import { spawn, execSync, ChildProcess } from "child_process";
import { getSettings, saveSettings } from "./data";

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelStatus: "stopped" | "starting" | "installing" | "running" | "error" = "stopped";
let tunnelError: string | null = null;

export function getTunnelState() {
  return {
    status: tunnelStatus,
    url: tunnelUrl,
    error: tunnelError,
  };
}

/** Find cloudflared binary path — checks PATH + common install locations */
function findCloudflared(): string | null {
  // Check PATH first
  try {
    return execSync("which cloudflared", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch { /* not in PATH */ }

  // Check common locations
  const candidates = [
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    `${process.env.HOME || ""}/.local/bin/cloudflared`,
    "/tmp/cloudflared",
  ];
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: "ignore" });
      return p;
    } catch { /* not found */ }
  }
  return null;
}

/** Find a writable directory on PATH, or fall back to a known location */
function findInstallDir(): string {
  // Try common writable paths in order
  const candidates = [
    "/usr/local/bin",
    "/usr/bin",
    process.env.HOME ? `${process.env.HOME}/.local/bin` : null,
    "/tmp",
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      // Check if directory exists and is writable
      execSync(`test -w "${dir}"`, { stdio: "ignore" });
      return dir;
    } catch {
      // Try creating ~/.local/bin if it doesn't exist
      if (dir.endsWith("/.local/bin")) {
        try {
          execSync(`mkdir -p "${dir}"`, { stdio: "ignore" });
          return dir;
        } catch { /* skip */ }
      }
    }
  }
  return "/tmp";
}

/** Auto-install cloudflared on Linux (Ubuntu sandbox) */
async function installCloudflared(): Promise<{ ok: boolean; error?: string }> {
  console.log("[Tunnel] cloudflared not found — attempting auto-install...");
  tunnelStatus = "installing";

  try {
    // Detect architecture
    const arch = execSync("uname -m", { encoding: "utf-8" }).trim();
    const isArm = arch === "aarch64" || arch === "arm64";
    const debUrl = isArm
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb"
      : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb";

    // Try dpkg install first (Debian/Ubuntu)
    try {
      console.log(`[Tunnel] Downloading cloudflared .deb for ${arch}...`);
      execSync(`curl -fsSL -o /tmp/cloudflared.deb "${debUrl}" && dpkg -i /tmp/cloudflared.deb && rm -f /tmp/cloudflared.deb`, {
        stdio: "pipe",
        timeout: 120000,
      });
      console.log("[Tunnel] cloudflared installed via dpkg");
      return { ok: true };
    } catch (dpkgErr: any) {
      console.log(`[Tunnel] dpkg install failed: ${dpkgErr.message?.slice(0, 100)}`);
    }

    // Fallback: download binary to a writable directory
    const binUrl = isArm
      ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
      : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

    const installDir = findInstallDir();
    const binPath = `${installDir}/cloudflared`;
    console.log(`[Tunnel] Downloading binary to ${binPath}...`);

    try {
      execSync(`curl -fsSL -o "${binPath}" "${binUrl}" && chmod +x "${binPath}"`, {
        stdio: "pipe",
        timeout: 120000,
      });
      console.log(`[Tunnel] cloudflared installed to ${binPath}`);

      // If installed to a non-PATH dir, add symlink or update PATH hint
      if (installDir === "/tmp") {
        console.log("[Tunnel] Warning: installed to /tmp — will not survive reboot");
      }

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: `Auto-install failed (tried dpkg + binary to ${installDir}): ${err.stderr?.toString()?.slice(0, 200) || err.message}` };
    }
  } catch (err: any) {
    return { ok: false, error: `Auto-install failed: ${err.message}` };
  }
}

export async function startTunnel(port: number): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (tunnelProcess) {
    return { ok: true, url: tunnelUrl || undefined };
  }

  // Check if tunnel is enabled in settings
  const settings = await getSettings();
  if (settings.tunnelEnabled === false) {
    return { ok: false, error: "Tunnel is disabled in settings. Enable it first." };
  }

  tunnelStatus = "starting";
  tunnelError = null;
  tunnelUrl = null;

  // Auto-install if not found
  let cloudflaredBin = findCloudflared();
  if (!cloudflaredBin) {
    const installResult = await installCloudflared();
    if (!installResult.ok) {
      tunnelStatus = "error";
      tunnelError = installResult.error || "Failed to install cloudflared";
      return { ok: false, error: tunnelError };
    }
    cloudflaredBin = findCloudflared();
    if (!cloudflaredBin) {
      tunnelStatus = "error";
      tunnelError = "cloudflared installed but binary not found";
      return { ok: false, error: tunnelError };
    }
  }

  console.log(`[Tunnel] Using cloudflared at: ${cloudflaredBin}`);
  tunnelStatus = "starting";

  return new Promise((resolve) => {
    const args = ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"];

    try {
      tunnelProcess = spawn(cloudflaredBin!, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      tunnelStatus = "error";
      tunnelError = `Failed to start cloudflared: ${err.message}`;
      resolve({ ok: false, error: tunnelError });
      return;
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (!tunnelUrl) {
          tunnelStatus = "error";
          tunnelError = "Tunnel started but no URL received within 30s";
          resolve({ ok: false, error: tunnelError });
        }
      }
    }, 30000);

    const handleOutput = (data: Buffer) => {
      const line = data.toString();
      // cloudflared prints the URL to stderr in the format:
      // ... https://xxxxx.trycloudflare.com ...
      const match = line.match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[1];
        tunnelStatus = "running";
        tunnelError = null;
        console.log(`[Tunnel] Cloudflare tunnel active: ${tunnelUrl}`);
        // Save URL to settings for display
        getSettings().then((s) => {
          s.tunnelUrl = tunnelUrl;
          saveSettings(s);
        }).catch(() => {});
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ ok: true, url: tunnelUrl });
        }
      }
    };

    tunnelProcess.stdout?.on("data", handleOutput);
    tunnelProcess.stderr?.on("data", handleOutput);

    tunnelProcess.on("error", (err) => {
      tunnelStatus = "error";
      tunnelError = `Tunnel error: ${err.message}`;
      tunnelProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: tunnelError });
      }
    });

    tunnelProcess.on("exit", (code) => {
      console.log(`[Tunnel] cloudflared exited with code ${code}`);
      tunnelStatus = "stopped";
      tunnelUrl = null;
      tunnelProcess = null;
      // Clear URL from settings
      getSettings().then((s) => {
        s.tunnelUrl = null;
        saveSettings(s);
      }).catch(() => {});
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: `cloudflared exited with code ${code}` });
      }
    });
  });
}

export function stopTunnel(): { ok: boolean } {
  if (tunnelProcess) {
    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
    tunnelUrl = null;
    tunnelStatus = "stopped";
    tunnelError = null;
    console.log("[Tunnel] Cloudflare tunnel stopped");
    // Clear URL from settings
    getSettings().then((s) => {
      s.tunnelUrl = null;
      saveSettings(s);
    }).catch(() => {});
  }
  return { ok: true };
}

/**
 * Auto-start tunnel if enabled in settings.
 * Called once at server boot.
 */
export async function initTunnel(port: number): Promise<void> {
  const settings = await getSettings();
  if (settings.tunnelEnabled) {
    console.log("[Tunnel] Auto-starting Cloudflare tunnel (tunnelEnabled=true)...");
    const result = await startTunnel(port);
    if (!result.ok) {
      console.error("[Tunnel] Auto-start failed:", result.error);
    }
  }
}
