![Tiger CoWork Banner](picture/screen_read.png)

# Tiger CoWork v1.4.0

A self-hosted AI workspace with chat, code execution, parallel multi-agent orchestration, cross-machine agent connection, and a skill marketplace. Mix different AI providers in the same agent team — OpenAI-compatible APIs, Claude Code CLI, and Codex CLI. Connect agents across machines on your network so distributed teams can collaborate in real time. Connect external MCP servers to extend the AI's toolbox. Built with 16 built-in tools and designed for long-running sessions with smart context compression and checkpoint recovery.

## What's New in v1.4.0

- **Host Folders** — browse and edit files on your host machine via VM shared folders directly from the Files page. UTM/VirtFS, VirtualBox, and VMware shared folders are auto-detected with proper labels and permissions. The AI agent is aware of all connected host folders and can read/write them.
- **Per-message feedback** — thumbs up/down and comment buttons on each assistant message in chat, feeding into the skill auto-update synthesizer so liked answers reinforce skills and disliked ones get corrected.
- **VM shared folder auto-detection** — parses `/proc/mounts` to identify 9p, virtiofs, vboxsf, and VMware FUSE mounts. Uses the mount tag (UTM share name) as the label instead of generic `shared-0` names. Host-origin folders are tagged with a green "Host" badge.
- **Files page tabs** — Sandbox and Host Folders tabs in the Files page. Local Files removed from sidebar to reduce confusion.
- **Agent host folder awareness** — all enabled host folder mounts with paths and permissions are injected into the AI agent's system prompt, so the agent can read from and write to shared folders.
- **Cross-browser local file access** — rewrote Local Files from Chrome-only File System Access API to server-side API, working in all browsers.

## What's New in v1.3.1

- **Fix custom skill Python execution** — skills with supporting Python scripts now execute correctly in the VM; fixed `sandboxDir` and `pythonPath` resolution so `run_python` no longer returns empty results when called from skill workflows
- **Fix output panel constant reloading** — React charts, images, and iframes in the output panel no longer re-render every 2-3 seconds; stabilized with `React.memo` deep comparison, global component cache, and removed URL cache-busting
- **Fix agent empty tool results** — when `run_python` returns empty stdout, errors and warnings from stderr are now promoted to stdout so the agent sees failures instead of fabricating answers
- **Python error visibility** — user code is wrapped in try/except so uncaught exceptions always appear in stdout with full traceback
- **VM settings persistence** — `sandboxDir` and `pythonPath` in `settings.json` are now auto-corrected before every service start via systemd `ExecStartPre`, surviving VM restarts
- **Project path migration** — old absolute paths in `projects.json` (e.g. `/root/cowork/...`) are automatically migrated to relative paths during VM provisioning
- **Terminal lands in /app** — VM terminal now opens in the application directory instead of `/root`

## What's New in v1.3.0

- **Live Agent Diagram** — real-time interactive graph showing orchestrator and worker agents with live status badges (Active/Waiting/Done), current tool calls, connection edge states (idle/working/awaiting result), and Bus protocol activity bar. Zoom, pan, and fullscreen controls for large agent teams.
- **Task & Remote Task Logs** — unified chat log panel streams timestamped tool calls, agent thinking/reasoning, and inter-agent delegation events. Pause/resume scrolling and view logs per session.
- **System Messages for Remote Tasks** — remote task delegation now includes system-level status messages showing remote agent progress, heartbeat, and completion across machines.
- **Async Parallel Sub-Agent Algorithm** — agents work in true parallel using async task dispatching; the orchestrator delegates via `send_task` and awaits results concurrently with `wait_result`, enabling all workers to execute simultaneously.
- **New P2P Algorithm** — improved peer-to-peer swarm with Contract Net Protocol bidding on the Blackboard, confidence-domain routing, and reputation-scored agent selection for decentralized task allocation.
- **Per-Project Agent Mode Override** — each project can override the global sub-agent mode (Auto Spawn, Auto Create, Manual, Realtime, Auto Swarm) and pick its own YAML config, architecture type, agent count, and connection protocols.
- **Auto Architecture — AI-Decided Settings** — new "Auto (AI decides)" option for architecture type and agent count (3-8 default). Connection protocols are now multi-select toggle buttons.
- **Full Chat Log with Agent Reasoning** — every chat session records a complete log capturing user messages, tool calls, sub-agent reasoning, and final responses.
- **Finished Tasks History** — Tasks page shows the last 100 completed/cancelled/errored tasks with status, duration, agents used, and tools called.

> **Warning:** This app executes AI-generated code and shell commands. Run it inside Docker or a sandboxed environment. See [Security & Docker Setup](docs/TECHNICAL.md#security-notice).

## Screenshots

![Tiger CoWork — AI chat with output panel](picture/screen3.jpg)

*AI Chat with tool-calling — generates React/Recharts visualizations rendered in the output panel.*

![Tiger CoWork — Agent System Editor](picture/agent2.jpg)

*Visual Agent Editor — drag-and-drop multi-agent design with mesh networking and YAML export.*

![Tiger CoWork — Minecraft Task Monitor](picture/screen5.png)

*Minecraft Task Monitor — live pixel-art agents with speech bubbles, walking animations, and inter-agent interactions.*

![Tiger CoWork — Live Agent Diagram](picture/diagram_task.png)

*Live Agent Diagram — real-time orchestrator/worker graph with status badges, tool call tracking, edge states, Bus activity bar, and chat log panel.*

## Benchmark

![FrontierScience-Olympiad Benchmark](picture/benchmark_frontier_science.png)

**FrontierScience-Olympiad accuracy** — Minimax 2.7 as a single agent scores 62%. With TigrimOS multi-agent orchestration, the same model reaches **75%**, surpassing Claude Opus 4.5 (71.4%) and Grok 4 (66.2%), and approaching Gemini 3 Pro (76.1%) and GPT-5.2 (77.1%).

## Key Features

- **AI Chat with 16 Built-in Tools** — web search, Python, React, shell, files, skills, sub-agents
- **Mix Any Model per Agent** — assign different AI providers per agent (API, Claude Code CLI, Codex CLI)
- **Parallel Multi-Agent System** — 7 orchestration topologies, 4 communication protocols, P2P swarm governance
- **Cross-Machine Agent Connection** — connect agents running on different machines over the network, enabling distributed multi-agent collaboration across your infrastructure
- **Minecraft Task Monitor** — live pixel-art characters (Steve, Creeper, Enderman, etc.) with speech bubbles showing agent activity, walking animations when agents interact
- **Long-Running Session Stability** — sliding window compression, smart tool result handling, checkpoint recovery
- **MCP Integration** — connect any Model Context Protocol server (Stdio, SSE, StreamableHTTP)
- **Output Panel** — renders React components, charts, HTML, PDF, Word, Excel, images, and Markdown
- **Skills & ClawHub** — install AI skills from the marketplace or build your own
- **Projects** — dedicated workspaces with memory, skill selection, and file browser

## Installation

### One-Click Installers

**Mac:**
1. Download [`TigerCoWork.zip`](https://github.com/Sompote/tiger_cowork/releases/latest)
2. Unzip, right-click `TigerCoWork.app` and select **Open**

**Windows:**
1. Download [`TigerCoWorkInstaller.zip`](https://github.com/Sompote/tiger_cowork/releases/latest)
2. Unzip and run `TigerCoWorkInstaller.bat`

**Prerequisite:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) must be installed and running.

| | Mac | Windows |
|---|---|---|
| **Start** | Double-click `TigerCoWork.app` | Double-click `TigerCoWorkStart.bat` |
| **Stop** | Docker Desktop → Containers → Stop | Double-click `TigerCoWorkStop.bat` |

### Terminal Install

**Mac/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/Sompote/tiger_cowork/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Sompote/tiger_cowork/main/install.ps1 | iex
```

### Manual Install

Log in to your Linux server directly or via SSH:
```bash
ssh root@<your-server-ip>
```

> **⚠️ Security Warning:** AI agents can execute arbitrary code and shell commands that may modify or delete files on the host system. It is strongly recommended to run Tiger CoWork on a **VPS or dedicated machine that contains no important data**. Do not run it on a machine with sensitive or irreplaceable information.

**Prerequisites:** Node.js >= 18, npm, Python 3 (optional)

```bash
git clone https://github.com/Sompote/tiger_cowork.git
cd tiger_cowork
bash setup.sh        # installs deps, prompts for ClawHub token
npm run build && npm start   # → http://localhost:3001
```

> **Running in background (recommended):** Use [PM2](https://pm2.keymetrics.io/) to keep Tiger CoWork running after you close the terminal.
>
> ```bash
> npm install -g pm2          # install PM2 globally
> npm run build               # build production bundle
> pm2 start npm --name "tiger-cowork" -- start   # start in background
> pm2 save                    # save process list for auto-restart
> pm2 startup                 # enable auto-start on system boot
> ```
>
> Useful PM2 commands:
> ```bash
> pm2 status                  # check running processes
> pm2 logs tiger-cowork       # view logs
> pm2 restart tiger-cowork    # restart
> pm2 stop tiger-cowork       # stop
> ```

> **First-time token:** The default token is `your-secret-token-here` in the UI. Please change it later in `.env` for your security.

## Quick Start

1. Open `http://localhost:3001`
2. Go to **Settings** → enter your API Key, API URL, and Model
3. Click **Test Connection** to verify
4. Start chatting — the AI can search the web, run code, generate charts, and more

## Documentation

| Document | Description |
|---|---|
| [Technical Documentation](docs/TECHNICAL.md) | Architecture, agent system, communication protocols, orchestration topologies, MCP setup, CLI agents, API endpoints, configuration |
| [Changelog](docs/CHANGELOG.md) | Full version history and release notes |

## License

This project is licensed under the [MIT License](LICENSE).
