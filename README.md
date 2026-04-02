<p align="center">
  <img src="tiger_cowork/picture/banner2.jpg" alt="TigrimOS Banner" width="100%">
</p>

# TigrimOS v1.0.0

A standalone macOS app — a self-hosted AI workspace with chat, code execution, parallel multi-agent orchestration, and a skill marketplace. Powered by Apple's Virtualization.framework. No Docker required.

TigrimOS runs everything inside a **secure Ubuntu sandbox**. AI-generated code and shell commands **cannot escape the sandbox** or touch your files without permission. Mix different AI providers in the same agent team — OpenAI-compatible APIs, Claude Code CLI, and Codex CLI. Connect external MCP servers to extend the AI's toolbox. Built with 16 built-in tools and designed for long-running sessions with smart context compression and checkpoint recovery.

> **Security first:** Everything runs inside a real Ubuntu VM. Your Mac's file system is completely invisible to the AI unless you explicitly share a folder.

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

| Mac | File | Architecture |
|-----|------|-------------|
| Apple Silicon (M1/M2/M3/M4) | **`TigrimOS.app`** | arm64 |
| Intel | **`TigrimOS_i.app`** | x86_64 |

## Requirements

- macOS 13.0 (Ventura) or later
- Xcode Command Line Tools (`xcode-select --install`)
- Homebrew with `qemu` (`brew install qemu`)
- 4 GB RAM available for the VM
- ~5 GB disk space (Ubuntu image + TigrimOS)

## Installation

### Ready-to-Run (pre-built)

1. Download the correct `.app` for your Mac (Intel or Apple Silicon)
2. Move it to `/Applications`
3. First launch: right-click the app → **Open** (bypasses Gatekeeper once)
4. If blocked: **System Settings → Privacy & Security → Open Anyway**

### Build from Source

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

## Quick Start

1. **Launch** TigrimOS — the app opens with a setup wizard on first run
2. **Wait** for Ubuntu VM to download and provision (~5-10 minutes on first launch)
3. **Open Settings** → enter your API Key, API URL, and Model
4. **Click Test Connection** to verify
5. **Start chatting** — the AI can search the web, run code, generate charts, and more

Subsequent launches start in ~30 seconds (no re-download).

## Key Features

- **AI Chat with 16 Built-in Tools** — web search, Python, React, shell, files, skills, sub-agents
- **Mix Any Model per Agent** — assign different AI providers per agent (API, Claude Code CLI, Codex CLI)
- **Parallel Multi-Agent System** — 7 orchestration topologies, 4 communication protocols, P2P swarm governance
- **Minecraft Task Monitor** — live pixel-art characters with speech bubbles showing agent activity
- **Long-Running Session Stability** — sliding window compression, smart tool result handling, checkpoint recovery
- **MCP Integration** — connect any Model Context Protocol server (Stdio, SSE, StreamableHTTP)
- **Output Panel** — renders React components, charts, HTML, PDF, Word, Excel, images, and Markdown
- **Skills & ClawHub** — install AI skills from the marketplace or build your own
- **Projects** — dedicated workspaces with memory, skill selection, and file browser

## Security Model

TigrimOS runs inside a full VM sandbox:

| Layer | Protection |
|-------|-----------|
| **VM Isolation** | Real Ubuntu 22.04 VM via Apple Virtualization.framework |
| **File System** | Host files are **invisible** to the VM by default |
| **Shared Folders** | You choose which folders to share — read-only by default |
| **Write Access** | Requires explicit per-folder toggle |
| **Network** | NAT networking — VM can access internet but is isolated from host network |
| **Process Isolation** | VM processes cannot see or affect Mac processes |
| **Audit Log** | All file access grants and revokes are logged |

### Shared Folders

By default the VM has **zero access** to your Mac's files. To share a folder:

1. Click the **Folders** tab in TigrimOS
2. Click **Add Folder** → select a macOS folder
3. Default: **read-only** (VM can read but not modify)
4. Toggle to **Read & Write** if needed (requires VM restart)
5. Shared folders appear inside the VM at `/mnt/shared/<name>`

## Architecture

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

## App Controls

| Tab | Description |
|-----|-------------|
| **App** | TigrimOS web UI embedded in the app |
| **Console** | VM boot log, provisioning output, service status |
| **Folders** | Manage which Mac folders the VM can access |

| Button | Action |
|--------|--------|
| **Start** | Boot the Ubuntu VM and start TigrimOS |
| **Stop** | Gracefully shut down the VM |
| **Settings → Reset VM** | Wipe and re-provision from scratch |

## Troubleshooting

### "App cannot be opened" on first launch
Right-click → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**.

### VM starts but TigrimOS doesn't load
Check the **Console** tab for errors. Common causes:
- First run provisioning still in progress (wait 5-10 minutes)
- Port 3001 is in use by another app — stop it first
- `qemu` not installed — run `brew install qemu`

### How to reset everything
In the app: **Settings → Reset VM**

Or manually:
```bash
rm -rf ~/Library/Application\ Support/TigrimOS/
```

### Where is the VM data stored?
```
~/Library/Application Support/TigrimOS/
├── ubuntu-cloud.qcow2    # Downloaded Ubuntu image (cached)
├── ubuntu-raw.img         # Converted raw disk
├── vmlinuz                # Linux kernel
├── initrd                 # Initial ramdisk
├── seed.img               # Cloud-init config
└── shared_folders.json    # Your shared folder settings
```

## Project Structure

```
TigrimOS/
├── TigrimOS.app              # Apple Silicon app (ready to run)
├── TigrimOS_i.app            # Intel app (ready to run)
├── src/                      # Source code project
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
└── tiger_cowork/             # AI workspace engine (mounted into VM)
```

## Documentation

| Document | Description |
|---|---|
| [Technical Docs](tiger_cowork/docs/TECHNICAL.md) | Architecture, agent system, protocols, MCP setup, API endpoints |
| [Changelog](tiger_cowork/docs/CHANGELOG.md) | Full version history and release notes |

## License

This project is licensed under the [MIT License](LICENSE).
