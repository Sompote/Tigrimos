<p align="center">
  <img src="tiger_cowork/picture/banner_tigrimos.png" alt="TigrimOS Banner" width="100%">
</p>

# TigrimOS v1.0.0

A self-hosted AI workspace with chat, code execution, parallel multi-agent orchestration, and a skill marketplace. Runs on **macOS** and **Windows**. Everything executes inside a **secure Ubuntu sandbox** — no Docker required.

AI-generated code and shell commands **cannot escape the sandbox** or touch your files without permission. Mix different AI providers in the same agent team — OpenAI-compatible APIs, Claude Code CLI, and Codex CLI. Connect external MCP servers to extend the AI's toolbox. Built with 16 built-in tools and designed for long-running sessions with smart context compression and checkpoint recovery.

> **Security first:** Everything runs inside a real Ubuntu sandbox. Your host file system is completely invisible to the AI unless you explicitly share a folder.

## Screenshots

<p align="center">
  <img src="tiger_cowork/picture/screen3.jpg" alt="TigrimOS — AI Chat" width="80%">
</p>

*AI Chat with tool-calling — generates React/Recharts visualizations rendered in the output panel.*

<p align="center">
  <img src="tiger_cowork/picture/agent2.jpg" alt="TigrimOS — Agent Editor" width="80%">
</p>

*Visual Agent Editor — drag-and-drop multi-agent design with mesh networking and YAML export.*

<p align="center">
  <img src="tiger_cowork/picture/screentask.png" alt="TigrimOS — Task Monitor" width="80%">
</p>

*Minecraft Task Monitor — live pixel-art agents with speech bubbles, walking animations, and inter-agent interactions.*

## Downloads

| Platform | File | Sandbox Technology |
|----------|------|--------------------|
| macOS — Apple Silicon (M1/M2/M3/M4) | **`TigrimOS.app`** | Apple Virtualization.framework |
| macOS — Intel | **`TigrimOS_i.app`** | Apple Virtualization.framework |
| Windows 10/11 | **`TigrimOSInstaller.bat`** | WSL2 (Windows Subsystem for Linux) |

## Requirements

### macOS

- macOS 13.0 (Ventura) or later
- Xcode Command Line Tools (`xcode-select --install`)
- Homebrew with `qemu` (`brew install qemu`)
- 4 GB RAM available for the VM
- ~5 GB disk space (Ubuntu image + TigrimOS)

### Windows

- Windows 10 version 2004+ or Windows 11
- WSL2 support (enabled automatically by the installer)
- 4 GB RAM available for the WSL2 instance
- ~5 GB disk space (Ubuntu + TigrimOS)

## Installation

### macOS — Ready-to-Run (pre-built)

1. Download the correct `.app` for your Mac (Intel or Apple Silicon)
2. Move it to `/Applications`
3. First launch: right-click the app → **Open** (bypasses Gatekeeper once)
4. If blocked: **System Settings → Privacy & Security → Open Anyway**

### macOS — Build from Source

```bash
git clone https://github.com/Sompote/TigrimOS.git
cd TigrimOS

# Install qemu (needed once, for disk image conversion)
brew install qemu

# Build for your Mac
swift build -c release

# Create the .app bundle
./Scripts/build.sh intel    # Intel Mac
./Scripts/build.sh silicon  # Apple Silicon Mac
./Scripts/build.sh all      # Both
```

### Windows — Installer

1. Download or clone the repository
2. Double-click **`TigrimOSInstaller.bat`**
3. The graphical installer will guide you through:
   - Enabling WSL2 (may require a one-time restart)
   - Installing Ubuntu 22.04 as a dedicated "TigrimOS" WSL2 distribution
   - Installing Node.js 20 + Python 3 inside the sandbox
   - Optionally connecting a shared folder (can also be done later from the app)
   - Cloning, building, and starting TigrimOS
4. TigrimOS opens as a **standalone desktop window** (Edge app mode — no browser tabs or address bar)
5. A desktop shortcut **TigrimOS** is created automatically

After installation, use **`TigrimOSStart.bat`** (or the desktop shortcut) to launch and **`TigrimOSStop.bat`** to stop.

## Quick Start

1. **Launch** TigrimOS
   - **macOS:** Open the app — the setup wizard runs on first launch
   - **Windows:** Double-click `TigrimOSStart.bat` or the desktop shortcut — opens as a standalone app window
2. **Wait** for the Ubuntu sandbox to provision (~5-10 minutes on first launch)
3. **Open Settings** → enter your API Key, API URL, and Model
4. **Click Test Connection** to verify
5. **Start chatting** — the AI can search the web, run code, generate charts, and more

Subsequent launches start in under a minute (no re-download).

## Connect a Local LLM (Ollama, llama.cpp, LM Studio)

TigrimOS can use AI models running on your host machine — no cloud API key needed.

### Step 1: Start your local model server on `0.0.0.0`

The server **must** listen on `0.0.0.0` (all interfaces), not `127.0.0.1`. The sandbox connects through a network bridge, so localhost-only servers are unreachable.

**llama.cpp / llama-server:**
```bash
llama-server -hf LiquidAI/LFM2.5-1.2B-Instruct-GGUF -c 4096 --port 8080 --host 0.0.0.0
```

**Ollama:**
```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

**LM Studio:**
In LM Studio settings → Server → set host to `0.0.0.0`, then start the server.

### Step 2: Configure TigrimOS

In the TigrimOS web UI, go to **Settings → AI Provider**:

| Field | llama.cpp | Ollama | LM Studio |
|-------|-----------|--------|-----------|
| **Provider** | OpenAI-Compatible (Local) | Ollama (Local) | LM Studio (Local) |
| **API URL** | `http://host.local:8080/v1` | `http://host.local:11434/v1` | `http://host.local:1234/v1` |
| **Model** | Your model name (e.g. `LiquidAI/LFM2.5-1.2B-Instruct-GGUF`) | `llama3.2`, `mistral`, etc. | `local-model` |
| **API Key** | `local` (any text) | `local` (any text) | `local` (any text) |

> **macOS:** `host.local` is a special hostname inside the VM that routes to your Mac. It's set up automatically during provisioning.
>
> **Windows:** `host.local` resolves to your Windows host via WSL2 networking. If it doesn't work, use your PC's local IP address (e.g. `192.168.1.x`).

### Step 3: Test Connection

Click **Test Connection** in Settings. If it succeeds, you're ready to chat.

### Troubleshooting Local LLM

| Problem | Solution |
|---------|----------|
| "fetch failed" | Make sure the server is running with `--host 0.0.0.0` |
| "Connection error" | Check the port number matches your server |
| "host.local not found" | **macOS:** Click **Reset VM** in toolbar → restart the app. **Windows:** Use your PC's IP instead |
| Server works in browser but not in TigrimOS | Your server is on `127.0.0.1` — restart with `0.0.0.0` |

## Key Features

- **AI Chat with 16 Built-in Tools** — web search, Python, React, shell, files, skills, sub-agents
- **Mix Any Model per Agent** — assign different AI providers per agent (API, Claude Code CLI, Codex CLI)
- **Parallel Multi-Agent System** — 7 orchestration topologies, 4 communication protocols, P2P swarm governance
- **Built-in Terminal** — full xterm.js terminal with root access to the Ubuntu sandbox (install packages, manage services, run CLI tools)
- **Minecraft Task Monitor** — live pixel-art characters with speech bubbles showing agent activity
- **Long-Running Session Stability** — sliding window compression, smart tool result handling, checkpoint recovery
- **MCP Integration** — connect any Model Context Protocol server (Stdio, SSE, StreamableHTTP)
- **Output Panel** — renders React components, charts, HTML, PDF, Word, Excel, images, and Markdown
- **Skills & ClawHub** — install AI skills from the marketplace or build your own
- **Projects** — dedicated workspaces with memory, skill selection, and file browser
- **Cross-Platform** — native macOS app + Windows WSL2 installer

## Sandbox Terminal

TigrimOS includes a built-in terminal (**Settings → Terminal**) that gives you root access to the Ubuntu sandbox. It runs a real PTY with full color, tab completion, and cursor support via xterm.js.

Use the terminal to install additional tools, manage services, or debug the sandbox environment.

### First-Time Setup: Claude Code CLI

To use **Claude Code** as an agent provider, install it once via the terminal:

1. Go to **Settings → Terminal → Open Terminal**
2. Run:
   ```bash
   npm i -g @anthropic-ai/claude-code
   ln -sf /root/.local/bin/claude /usr/local/bin/claude
   ```
3. Set your API key:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> /root/.bashrc
   ```
4. Test it:
   ```bash
   claude --version
   ```

Claude Code is now available as an agent type in the Agent Editor.

### First-Time Setup: Codex CLI

To use **OpenAI Codex CLI** as an agent provider:

1. Go to **Settings → Terminal → Open Terminal**
2. Run:
   ```bash
   npm i -g @openai/codex
   ```
3. Set your API key:
   ```bash
   export OPENAI_API_KEY=sk-...
   echo 'export OPENAI_API_KEY=sk-...' >> /root/.bashrc
   ```
4. Test it:
   ```bash
   codex --version
   ```

Codex CLI is now available as an agent type in the Agent Editor.

> **Note:** These CLI tools are installed **inside the sandbox** — they cannot access your host system. API keys stored in the sandbox are isolated from your host environment.

## Security Model

TigrimOS runs inside a full sandbox on both platforms:

| Layer | macOS | Windows |
|-------|-------|---------|
| **Sandbox** | Ubuntu 22.04 VM via Virtualization.framework | Ubuntu 22.04 via WSL2 |
| **File System** | Host files **invisible** by default | Host files **invisible** by default |
| **Shared Folders** | VirtioFS opt-in, read-only default | Symlink opt-in via installer or app UI |
| **Write Access** | Requires explicit per-folder toggle | Read & write by default (Windows folder permissions apply) |
| **Network** | NAT — VM isolated from host network | WSL2 NAT — isolated from host network |
| **Process Isolation** | VM processes cannot see host processes | WSL2 processes isolated from Windows |

### Shared Folders (macOS)

By default the VM has **zero access** to your Mac's files. To share a folder:

1. Click the **Folders** tab in TigrimOS
2. Click **Add Folder** → select a macOS folder
3. Default: **read-only** (VM can read but not modify)
4. Toggle to **Read & Write** if needed (requires VM restart)
5. Shared folders appear inside the VM at `/mnt/shared/<name>`

### Shared Folders (Windows)

There are two ways to connect Windows folders to the sandbox:

**From the app (recommended):**

1. Open the **Files** page in TigrimOS
2. Click **Connect Folder**
3. Enter the Windows path (e.g. `C:\Users\YOU\Documents`)
4. Optionally give it a display name
5. Click **Connect** — the folder appears under `shared/` in the file browser

To disconnect: navigate to `shared/`, click the **x** on the linked folder.

**During installation:**

The installer optionally lets you pick a shared folder. It is linked into the sandbox automatically.

**Manual (command line):**

```powershell
wsl -d TigrimOS -u root -- bash -c "mkdir -p /opt/TigrimOS/tiger_cowork/shared && ln -sf /mnt/c/Users/YOU/Documents /opt/TigrimOS/tiger_cowork/shared/docs"
```

## Architecture

### macOS

```
┌──────────────────────────────────────────────────┐
│               TigrimOS.app (macOS)               │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │      SwiftUI + WKWebView (port 3001)       │  │
│  └────────────────┬───────────────────────────┘  │
│                   │                              │
│  ┌────────────────▼───────────────────────────┐  │
│  │       Apple Virtualization.framework       │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │        Ubuntu 22.04 VM               │  │  │
│  │  │                                      │  │  │
│  │  │   TigrimOS v1.0.0                   │  │  │
│  │  │   ├── Fastify server :3001          │  │  │
│  │  │   ├── Node.js 20                    │  │  │
│  │  │   ├── Python 3 + numpy/pandas/...   │  │  │
│  │  │   └── 16 built-in AI tools          │  │  │
│  │  │                                      │  │  │
│  │  │   /mnt/shared/ ← VirtioFS (opt-in) │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ~/TigrimOS_Shared/ (user-controlled, optional)  │
└──────────────────────────────────────────────────┘
```

### Windows

```
┌──────────────────────────────────────────────────┐
│            TigrimOSStart.bat (Windows)           │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │   Edge App Window → http://localhost:3001  │  │
│  └────────────────┬───────────────────────────┘  │
│                   │                              │
│  ┌────────────────▼───────────────────────────┐  │
│  │       WSL2 (Windows Subsystem for Linux)   │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │     Ubuntu 22.04 "TigrimOS" distro  │  │  │
│  │  │                                      │  │  │
│  │  │   TigrimOS v1.0.0                   │  │  │
│  │  │   ├── Fastify server :3001          │  │  │
│  │  │   ├── Node.js 20                    │  │  │
│  │  │   ├── Python 3 + numpy/pandas/...   │  │  │
│  │  │   └── 16 built-in AI tools          │  │  │
│  │  │                                      │  │  │
│  │  │   shared/ ← symlinks to Windows (opt-in) │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  C:\Users\YOU\Documents (connected via app UI)   │
└──────────────────────────────────────────────────┘
```

## App Controls

### macOS

| Tab | Description |
|-----|-------------|
| **App** | TigrimOS web UI embedded in the app |
| **Console** | VM boot log, provisioning output, service status |
| **Folders** | Manage which Mac folders the VM can access |

| Button | Action |
|--------|--------|
| **Start** | Boot the Ubuntu VM and start TigrimOS |
| **Stop** | Gracefully shut down the VM |
| **Reset VM** | Wipe and re-provision from scratch |

### Windows

| Script | Action |
|--------|--------|
| **TigrimOSStart.bat** | Start the WSL2 server and open as a standalone app window |
| **TigrimOSStop.bat** | Stop the TigrimOS server |
| **TigrimOSInstaller.bat** | Re-run installer (update or repair) |

| In-App Feature | Description |
|----------------|-------------|
| **Files → Connect Folder** | Link a Windows folder into the sandbox for reading/writing |
| **Files → shared/** | Browse and manage all connected Windows folders |

## Troubleshooting

### macOS

**"App cannot be opened" on first launch**
Right-click → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**.

**VM starts but TigrimOS doesn't load**
Check the **Console** tab for errors. Common causes:
- First run provisioning still in progress (wait 5-10 minutes)
- Port 3001 is in use by another app — stop it first
- `qemu` not installed — run `brew install qemu`

**How to reset everything**
In the app: click **Reset VM** in the toolbar.

Or manually:
```bash
rm -rf ~/Library/Application\ Support/TigrimOS/
```

**Where is the VM data stored?**
```
~/Library/Application Support/TigrimOS/
├── ubuntu-cloud.qcow2    # Downloaded Ubuntu image (cached)
├── ubuntu-raw.img         # Converted raw disk
├── vmlinuz                # Linux kernel
├── initrd                 # Initial ramdisk
├── seed.img               # Cloud-init config
└── shared_folders.json    # Your shared folder settings
```

### Windows

**"WSL2 is not installed or not enabled"**
Run `TigrimOSInstaller.bat` — it enables WSL2 automatically. You may need to restart your PC after the first run.

**Installer says "restart required"**
WSL2 requires a one-time Windows restart after enabling. Restart and run the installer again.

**Installer fails with PowerShell errors**
The installer requires PowerShell 5.1+ (included with Windows 10). If you see parse errors, make sure you are running the latest Windows updates.

**Server doesn't start**
Check the log inside WSL:
```powershell
wsl -d TigrimOS -u root -- cat /tmp/tigrimos.log
```

**App window doesn't open (but server is running)**
TigrimOS opens as an Edge app-mode window. If Edge is not installed, it falls back to your default browser. You can always access TigrimOS at `http://localhost:3001`.

**Connected folder not visible in file browser**
Connected folders appear under `shared/` in the file browser. Navigate to the `shared` directory to see linked Windows folders.

**How to reset everything (Windows)**
```powershell
wsl --unregister TigrimOS
wsl --unregister Ubuntu-22.04
```
Then run `TigrimOSInstaller.bat` again.

**Where is WSL data stored?**
```
%LOCALAPPDATA%\TigrimOS\WSL\    # WSL2 virtual disk
```

## Project Structure

```
TigrimOS/
├── TigrimOS.app              # macOS Apple Silicon app (ready to run)
├── TigrimOS_i.app            # macOS Intel app (ready to run)
├── TigrimOSInstaller.bat     # Windows installer launcher
├── TigrimOSStart.bat         # Windows start script
├── TigrimOSStop.bat          # Windows stop script
├── install_windows.ps1       # Windows WPF installer (WSL2-based)
├── src/                      # macOS native app source
│   ├── Package.swift
│   ├── TigrimOS/
│   │   ├── TigrimOSApp.swift
│   │   ├── VM/
│   │   │   ├── VMConfig.swift
│   │   │   └── VMManager.swift
│   │   ├── Views/
│   │   │   ├── ContentView.swift
│   │   │   ├── TigrimOSWebView.swift
│   │   │   ├── ConsoleView.swift
│   │   │   ├── SharedFoldersView.swift
│   │   │   ├── SettingsView.swift
│   │   │   └── SetupView.swift
│   │   ├── Security/
│   │   │   ├── SandboxManager.swift
│   │   │   └── FileAccessControl.swift
│   │   └── Resources/
│   │       ├── AppIcon.icns
│   │       ├── provision.sh
│   │       └── cloud-init.yaml
│   └── Scripts/
│       ├── build.sh
│       ├── create-dmg.sh
│       └── setup-vm.sh
└── tiger_cowork/             # AI workspace engine (runs inside sandbox)
```

## Documentation

| Document | Description |
|---|---|
| [Platform Architecture](docs/TECHNICAL.md) | How TigrimOS runs across macOS Silicon, macOS Intel, and Windows — VM boot, provisioning, file sharing, security |
| [Agent & Tools Docs](tiger_cowork/docs/TECHNICAL.md) | Agent system, tools, protocols, MCP setup, API endpoints |
| [Changelog](tiger_cowork/docs/CHANGELOG.md) | Full version history and release notes |

## License

This project is licensed under the [MIT License](LICENSE).
