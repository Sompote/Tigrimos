# Tiger Cowork — Technical Documentation

## Architecture

![Tiger Cowork Agent Workflow](../picture/tiger_cowork_workflow.png)

The diagram above illustrates the **Tool Use & Reasoning Loop** at the core of Tiger Cowork's AI agent:

1. **User Input** — The user sends a message through the chat interface.
2. **Agent Reasoning** — The AI analyzes the query and plans which actions to take.
3. **Need Tools?** — A decision point: if the query can be answered from knowledge alone, the agent returns a **Direct Response**. If tools are needed, it proceeds to tool selection.
4. **Select Tool → Execute Tool** — The agent picks the appropriate tool (e.g. `web_search`, `run_python`, `fetch_url`, `run_react`) and executes it.
5. **Observation** — The tool result is captured and fed back into the agent's context.
6. **Update Context** — Memory and conversation context are updated with the new result.
7. **Task Done?** — Another decision point: if the task requires more information, the agent loops back to select and execute additional tools (configurable, default 8 rounds / 12 calls). Once complete, it proceeds to reflection.
8. **Reflection Loop Check** — If enabled, the agent evaluates whether it satisfied the user's objective. If the score is below the threshold, it re-enters the tool loop to address gaps.
9. **User Output** — The final answer, along with any generated files (charts, components, reports), is delivered to the user.

The bottom section shows all **Available Tools** organized by category — web search, URL fetching, Python/React execution, shell commands, file operations, skill management, ClawHub marketplace, and external MCP tools.

### Agent Reflection Loop Protocol

The Reflection Loop is an optional self-evaluation mechanism that checks whether the agent's work actually satisfied the user's objective before returning a response. When enabled, it adds an extra quality-assurance step after the tool loop completes.

**How it works:**

```
Tool Loop Completes
       │
       ▼
┌─────────────────────────┐
│ Extract user objective   │
│ from conversation        │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ LLM Evaluation Call      │◄──────────────────┐
│ (judge role)             │                   │
│                          │                   │
│ Scores 0.0 – 1.0        │                   │
│ Returns: score,          │                   │
│   satisfied, missing     │                   │
└───────────┬─────────────┘                   │
            ▼                                  │
     score >= threshold                        │
     OR satisfied=true?                        │
        │          │                           │
       YES         NO                          │
        │          │                           │
        ▼          ▼                           │
   ┌────────┐  ┌──────────────────┐           │
   │ PASS   │  │ Inject feedback: │           │
   │ Done!  │  │ "Score X, gaps:  │           │
   └────────┘  │  {missing}"      │           │
               │ Re-enter tool    │───────────┘
               │ loop to fix gaps │  (up to maxReflectionRetries)
               └──────────────────┘
```

1. **Objective Extraction** — The system collects all user messages from the conversation to determine the original objective.
2. **Evaluation Judge** — A separate LLM call evaluates the agent's work. It receives the user objective, a summary of all tool actions taken, and the agent's last response. It returns a structured JSON score:
   ```json
   {"score": 0.95, "satisfied": true, "missing": ""}
   ```
3. **Scoring Guide:**
   - `1.0` — Fully satisfied, all parts addressed
   - `0.7–0.9` — Mostly satisfied, minor gaps
   - `0.4–0.6` — Partially satisfied, significant gaps
   - `0.0–0.3` — Not satisfied, major parts missing
4. **Pass/Fail Decision** — If `score >= agentEvalThreshold` (default 0.7) OR `satisfied: true`, the agent passes and proceeds to generate the final response.
5. **Retry on Failure** — If the score is below the threshold, the system injects a feedback message describing the gaps and re-enters the tool loop. The agent gets additional tool rounds to address what's missing. This retry can repeat up to `agentMaxReflectionRetries` times (default 2).

**Settings for Reflection Loop:**

| Setting | Default | Description |
|---|---|---|
| `agentReflectionEnabled` | `false` | Enable/disable the reflection evaluation after tool loops |
| `agentEvalThreshold` | `0.7` | Minimum score (0.0–1.0) to pass. Lower = more lenient, higher = stricter |
| `agentMaxReflectionRetries` | `2` | Max times the agent can retry if evaluation fails |

**Trade-offs:**
- **Enabled** — Higher quality responses, catches incomplete work, but uses extra API tokens for the evaluation call (and potentially retry rounds)
- **Disabled** — Faster and cheaper, but the agent may return incomplete work without self-checking

### Sub-Agent System

The Sub-Agent system allows the main agent to delegate specific sub-tasks to independent child agents. Each sub-agent runs its own tool loop, has access to the same tools, and returns results back to the parent agent. This enables parallel task decomposition and hierarchical problem solving.

Three operating modes are available:

| Mode | How it works |
|---|---|
| **Auto** | AI decides when to spawn sub-agents on the fly. Best for ad-hoc tasks. |
| **Spawn Agent** | Agents are defined in a YAML config. The AI spawns them on demand following the workflow sequence. Each agent only gets the tools and downstream targets defined in the config. |
| **Realtime Agent** | All agents from the YAML config boot at session start and stay alive. Tasks are sent via `send_task` / `wait_result` for true parallel execution. Agents communicate through the message bus and protocol tools. |

**How it works (Auto / Spawn Agent mode):**

```
Parent Agent (processing user request)
       │
       ├── Decides a sub-task can be delegated
       │
       ▼
┌─────────────────────────────┐
│ spawn_subagent tool call     │
│                              │
│ task: "Analyze sales.csv"    │
│ label: "Data Analyst"        │
│ context: "Focus on Q1 trends"│
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Sub-Agent Created            │
│ ID: subagent_17732_a3f1      │
│ Depth: 1                     │
│                              │
│ Gets own system prompt       │
│ Gets own tool loop           │
│ Full tool access (minus      │
│   spawn_subagent at max      │
│   depth)                     │
└──────────────┬──────────────┘
               │
               ├── Executes tools (read_file, run_python, etc.)
               ├── Streams status via Socket.IO
               │
               ▼
┌─────────────────────────────┐
│ Returns to Parent:           │
│  • result (final response)   │
│  • toolCalls (tools used)    │
│  • outputFiles (generated)   │
└─────────────────────────────┘
```

**How it works (Realtime Agent mode):**

```
User sends a message
       │
       ▼
┌──────────────────────────────┐
│ All agents boot from YAML     │
│ config and enter idle state   │
│ (shown in chat: "🟢 ready")   │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Orchestrator (the LLM) uses   │
│ send_task({to, task}) to      │
│ assign work to agents         │
│                               │
│ Multiple send_task calls in   │
│ one response = parallel exec  │
└──────────────┬───────────────┘
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
  Agent A   Agent B   Agent C
  (working)  (working)  (working)
     │         │         │
     └─────────┼─────────┘
               ▼
┌──────────────────────────────┐
│ wait_result({from}) collects  │
│ results from each agent       │
│                               │
│ check_agents shows status of  │
│ all agents in the session     │
└──────────────┬───────────────┘
               ▼
     Final synthesized response
```

**Key features:**

- **Three modes** — Auto (AI decides), Spawn Agent (YAML-defined, on-demand), Realtime Agent (YAML-defined, always-on)
- **Depth control** — In Auto mode, sub-agents can spawn their own sub-agents up to a configurable max depth (default 2). In Spawn Agent mode, the YAML workflow structure is the boundary — agents can only spawn downstream targets defined in `outputs_to` and connections.
- **Protocol-aware tooling** — Each agent only receives the protocol tools it's configured to use: bus tools if `bus.enabled` (or hybrid orchestrator), TCP/queue tools for connected protocols, and send_task/wait_result for mesh-enabled agents with full peer lists.
- **Concurrency limit** — Controls how many sub-agents can run simultaneously (default 3).
- **Timeout** — Each sub-agent has a configurable timeout (default 120 seconds) enforced via AbortController.
- **Model override** — Sub-agents can use a different model than the parent (e.g. a faster/cheaper model for simple sub-tasks).
- **Real-time status** — All agent events (spawn, tool execution, delegation, completion, errors) are broadcast via Socket.IO with protocol-tagged status messages in the chat UI.
- **Auto-cleanup** — Completed sub-agents are automatically removed from the tracking map after 60 seconds (30 seconds on error).

**Settings for Sub-Agent System:**

| Setting | Default | Description |
|---|---|---|
| `subAgentEnabled` | `false` | Enable/disable sub-agent spawning |
| `subAgentMode` | `auto` | Operating mode: `auto`, `manual` (Spawn Agent), or `realtime` |
| `subAgentConfigFile` | *(empty)* | YAML config file for Spawn Agent / Realtime modes |
| `subAgentModel` | *(empty)* | Model override for sub-agents (uses main model if empty) |
| `subAgentMaxDepth` | `2` | Maximum nesting depth (1–5, Auto mode only) |
| `subAgentMaxConcurrent` | `3` | Maximum simultaneous sub-agents (1–10) |
| `subAgentTimeout` | `120` | Timeout per sub-agent in seconds (30–600) |

Configure these in **Settings > Agent Parameters > Sub-Agent**.

## Features (Detailed)

### AI Chat with Tool Calling
- Conversational AI assistant with automatic tool use
- 16 built-in tools: web search, URL fetch, Python execution, React rendering, shell commands, file read/write/list, skill management, ClawHub marketplace, sub-agent spawning, and realtime agent orchestration (send_task, wait_result, check_agents)
- Configurable tool loop limits: max tool rounds (default 8), max tool calls (default 12), consecutive error threshold, and result truncation length — all adjustable in Settings > Agent Parameters
- **Sub-Agent Spawning** — Delegate sub-tasks to independent child agents with their own tool loops. Three modes: Auto (AI decides), Spawn Agent (YAML-defined), Realtime Agent (always-on). Configurable: depth limits, concurrency, timeout, and model override
- **Reflection Loop** — Optional self-evaluation after tool loops. The agent scores its own work against the user's objective and retries if the score is below the threshold. Configurable: enable/disable, score threshold (0.0–1.0), max retries
- **Agent System Editor** — Visual drag-and-drop editor for designing multi-agent systems. Define agent roles, models, personas, and responsibilities. Connect agents via port-based drawing with communication protocols (TCP, Queue). Per-agent Bus toggle (broadcast data sharing) and Mesh toggle (free peer-to-peer task delegation). Hybrid architecture mode combines orchestrator control with mesh peer collaboration. Built-in file manager for YAML upload/load/delete. AI-assisted agent setup and YAML export
- Real-time streaming of responses and tool call progress via Socket.IO
- Automatic output file generation for analysis/chart requests
- File attachments with image vision support

### Projects
- Create dedicated projects to organize related work in one place
- **Working folder** — Two location options:
  - **In Sandbox** — Creates a folder inside the sandbox directory. Always has full access (read, write, execute). Best for AI-generated content.
  - **External Folder** — Mount any local path outside the sandbox (e.g. `/home/user/research`). Choose an access level:
    - **Read Only** — Agent can read files but cannot modify anything
    - **Read & Write** — Agent can read and write files but cannot run shell commands
    - **Full Access** — Agent can read, write, and execute shell commands
- **Docker volume mounts** — For external folders, the Overview tab generates ready-to-copy `docker run` and `docker-compose` volume mount commands with correct `:ro`/`:rw` flags
- **Project memory** — A persistent markdown notepad injected into every chat message as context. Record tech stack decisions, conventions, key file paths, or anything the AI should remember across sessions. Includes **auto-generate from chat** — the LLM analyzes project chat history and drafts a structured memory document for you to review and confirm
- **Skill selection** — Choose which installed skills are available for each project. The backend enforces this selection — only selected skills are included in the LLM system prompt, not just hinted as priorities
- **Project chat** — Each project has its own chat interface with a session sidebar. Chat sessions are automatically prefixed with the project name and inherit the project's memory, working folder, and selected skills as context
- **Output panel** — Generated files (React components, charts, HTML reports, PDFs, Word documents) render in a collapsible right-side panel within the project chat, just like the main chat
- **Overview dashboard** — Quick glance at working folder, location type, access level, memory size, and selected skill count

### Agent System Editor
- Visual drag-and-drop canvas for designing multi-agent systems
- **Agent nodes** — Create agents with configurable roles (human, orchestrator, worker, checker, reporter, researcher), any LLM model (free-text input), personas, and responsibility lists
- **Connection drawing** — Drag from an output port (right side) to an input port (left side) to create connections with communication protocols:
  - **TCP** — Bidirectional async socket communication for direct task delegation
  - **Queue** — Message queue handoff for async ordered delivery
- **Bus toggle** — Enable/disable the shared message bus per agent. Configure bus topics for targeted pub/sub data sharing. Bus is for broadcasting data between agents, not for task assignment
- **Mesh toggle** — Enable/disable per-agent mesh networking. Mesh-enabled agents can freely send tasks to any other agent without needing connection lines, enabling flexible peer-to-peer collaboration
- **AI-assisted setup** — Describe the agent you need in natural language, and the editor generates the role, persona, model, and responsibilities automatically
- **Auto Architecture** — Describe the system you want in natural language, and the LLM generates a complete multi-agent architecture with agents, connections, bus/mesh settings, and proper role assignment
- **Orchestration modes** — Choose from Hierarchical, Flat, Mesh, Hybrid, or Pipeline topologies. Hybrid combines an orchestrator (controls flow via connections) with mesh-enabled workers (collaborate as peers)
- **YAML export** — The editor generates a complete YAML configuration including system metadata, agent definitions, bus/mesh settings, workflow sequences, connection topology, and communication settings
- **File manager** — Upload, load, and delete YAML architecture files directly within the editor. Shows existing configs with agent count and metadata
- **Save & load** — Save agent configurations as `.yaml` files in `data/agents/`, load existing configs back into the editor
- **YAML upload** — Upload existing `.yaml` / `.yml` files from your local machine into the editor or from the Settings page
- **Preview** — Preview the generated YAML before saving, with copy-to-clipboard support

### Output Panel
- Collapsible right-side panel that renders all generated files from chat
- **React/JSX** — AI-generated React components compiled server-side and rendered natively in the browser with Recharts support
- **Images** — PNG, JPG, GIF, WebP, SVG, BMP with click-to-expand preview
- **HTML reports** — Rendered in sandboxed iframes
- **PDF files** — Inline preview with extracted text and page count
- **Word documents** — DOCX/DOC preview with converted HTML content
- **Excel files** — XLS/XLSX rendered as HTML tables with sheet names
- **Markdown files** — Rendered with GFM support (headings, tables, code blocks, blockquotes)
- **Other files** — Download chips for any other format
- Toggle button with file count badge when the panel is closed

### File Browser (Sandbox Files)
- Browse, upload, create, and delete files in the sandbox directory
- **Rich preview** — Click any file to see a visual preview instead of raw content:
  - Images (PNG, JPG, GIF, WebP, SVG, BMP) — inline display
  - HTML — rendered in iframe
  - Excel (XLS/XLSX) — parsed and displayed as styled tables
  - PDF — extracted text with page breaks
  - Word (DOC/DOCX) — converted to HTML
  - Markdown — rendered with GFM (tables, code blocks, headings)
  - Video (MP4, WebM) / Audio (MP3, WAV, OGG) — native player controls
  - Text files — source code with edit/save support
- Drag-and-drop file upload
- Breadcrumb navigation and directory creation

### Python Execution
- Run Python code directly from chat or the dedicated Python runner
- Working directory is `output_file/` with `PROJECT_DIR` variable for accessing project files
- 60-second timeout, output truncated at 20KB stdout / 5KB stderr
- Generated files (charts, reports, CSVs) render in the output panel

### React Playground
- Generate interactive React/JSX components from chat
- Server-side JSX compilation via esbuild
- Recharts library available as globals (LineChart, BarChart, PieChart, etc.)
- Components render natively in the browser output panel via `ReactComponentRenderer`
- Import statements are auto-stripped; React hooks destructured automatically

### Scheduled Tasks
- Create cron-based scheduled jobs that run shell commands
- Common presets: every minute, hourly, daily, weekly
- Pause, resume, or delete tasks from the UI

### Skills & ClawHub Marketplace
- Search, install, and manage reusable AI skills from ClawHub/OpenClaw catalog
- AI can browse and install skills directly from chat
- Skills extend the AI's tool-calling capabilities via `SKILL.md` instructions

### MCP Tool Integration
- Connect external MCP servers (Stdio, SSE, StreamableHTTP)
- Auto-discovers tools from connected servers
- Tools appear alongside built-in tools for the AI to use
- Configure via Settings page; supports multiple simultaneous connections

### Web Search
- DuckDuckGo (instant answer + HTML scraping) built-in
- Optional Google Custom Search API support
- Wikipedia search as supplementary source

## Tech Stack

| Layer    | Technology                                                |
|----------|-----------------------------------------------------------|
| Frontend | React 18, React Router 6, Vite 5, Socket.IO Client 4     |
| Backend  | Node.js, Fastify 5, Socket.IO 4, TypeScript               |
| AI       | Any OpenAI-compatible API (OpenRouter, TigerBot, etc.)     |
| Tools    | MCP SDK 1.27, esbuild (JSX), node-cron, Python 3          |
| Data     | JSON file-based persistence (`data/` directory)            |

## Security Notice

> **This app can execute shell commands, Python code, and install third-party skills.** For safety, it is strongly recommended to run Tiger Cowork inside a sandboxed environment such as a **Docker container**.

### Recommended: Run in Docker (Ubuntu)

```bash
docker run -it -p 3001:3001 ubuntu bash

# Inside the container:
apt-get update && apt-get install -y curl git python3 python3-pip
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

node --version

git clone https://github.com/Sompote/tiger_cowork.git
cd tiger_cowork
bash setup.sh

# Set access token (recommended)
echo 'ACCESS_TOKEN=your-secret-token' > .env

npm run dev
```

### Mounting External Folders in Docker

To let the app access folders on your host machine, use Docker `-v` volume mounts when starting the container.

#### Quick start (no external folders)

```bash
docker run -it -p 3001:3001 ubuntu bash
# Then install and run inside the container (see above)
```

#### Mount a parent folder for full access

```bash
# macOS
docker run -it -p 3001:3001 \
  -v /Users/yourname:/mnt/host:rw \
  ubuntu bash

# Linux
docker run -it -p 3001:3001 \
  -v /home/yourname:/mnt/host:rw \
  ubuntu bash
```

Then in the app, create a project with **External Folder** pointing to `/mnt/host/any-subfolder`.

#### Mount specific folders

```bash
# Mount a single folder (read-write)
docker run -it -p 3001:3001 \
  -v /Users/yourname/research:/mnt/projects/research:rw \
  ubuntu bash

# Mount read-only
docker run -it -p 3001:3001 \
  -v /Users/yourname/data:/mnt/projects/data:ro \
  ubuntu bash

# Mount multiple folders
docker run -it -p 3001:3001 \
  -v /Users/yourname/project-a:/mnt/projects/a:rw \
  -v /Users/yourname/project-b:/mnt/projects/b:ro \
  ubuntu bash
```

#### Important notes

- **Folders must be mounted at startup** — you cannot add new host folders after the container is running. If you need a new folder, stop and restart with the updated `-v` flags.
- **Tip:** Mount a big parent folder (like your home directory) to avoid restarting when you need to access a new subfolder.
- `:rw` = read-write access, `:ro` = read-only access.

#### Auto-generate mount commands from the app

You can also generate these commands automatically:
1. Create projects with **External Folder** working folders
2. Set the desired access level for each
3. Go to **Overview** tab > **Docker Volume Mounts** to get the exact `docker run` and `docker-compose` commands

## Configuration

### API Key Setup

1. Open the app at `http://localhost:3001`
2. Navigate to **Settings** in the sidebar
3. Enter your **API Key** (any OpenAI-compatible provider)
4. Set the **API URL** — e.g. `https://openrouter.ai/api/v1` for OpenRouter
5. Choose a **Model** — e.g. `z-ai/glm-5`, `TigerBot-70B-Chat`, etc.
6. Click **Test Connection** to verify

### Access Token Protection

Tiger Cowork supports a simple access token to protect the app from unauthorized access.

**Setup:**

1. Create a `.env` file in the project root (or copy from `.env.example`):
```bash
cp .env.example .env
```

2. Set your access token:
```env
ACCESS_TOKEN=your-secret-token-here
```

3. Restart the server — a login screen will appear requiring the token.

**How it works:**
- All `/api/*` routes require a valid `Authorization: Bearer <token>` header
- Socket.IO connections require the token via `auth.token` in the handshake
- The client stores the token in `localStorage` after successful login
- If the token is invalid or missing, the client shows a login screen
- File downloads pass the token via `?token=` query parameter
- To **disable** auth, leave `ACCESS_TOKEN` empty or remove it from `.env`

### Environment Variables

| Variable       | Default            | Description                          |
|----------------|--------------------|--------------------------------------|
| `ACCESS_TOKEN` | *(empty)*          | Access token to protect the app (leave empty to disable) |
| `PORT`         | `3001`             | Server port                          |
| `SANDBOX_DIR`  | `.` (project root) | Directory for file manager sandbox   |
| `NODE_ENV`     | `development`      | Set to `production` for built assets |

```bash
ACCESS_TOKEN=mysecret PORT=8080 SANDBOX_DIR=/home/user/workspace npm run dev
```

### MCP Server Configuration

1. Go to **Settings** > MCP Tools
2. Add a server with a name and URL:
   - HTTP/SSE: `https://mcp-server.example.com/sse`
   - Stdio: `node /path/to/mcp-server.js`
3. Enable the server — tools are auto-discovered
4. Connected MCP tools appear as `mcp_{serverName}_{toolName}` in the AI's toolbox

## Built-in AI Tools

| Tool             | Description                                              |
|------------------|----------------------------------------------------------|
| `web_search`     | Search via DuckDuckGo/Google/Wikipedia                   |
| `fetch_url`      | Fetch content from any URL (JSON or text)                |
| `run_python`     | Execute Python code with file output support             |
| `run_react`      | Compile and render React/JSX components with Recharts    |
| `run_shell`      | Execute shell commands (30s timeout)                     |
| `read_file`      | Read file contents (truncated at 30KB)                   |
| `write_file`     | Write or append content to files                         |
| `list_files`     | List directory contents (max 200 entries)                |
| `list_skills`    | List all installed skills (built-in + ClawHub)           |
| `load_skill`     | Load a skill's SKILL.md instructions                     |
| `clawhub_search` | Search the ClawHub skill marketplace                     |
| `clawhub_install`| Install a skill from ClawHub by slug                     |
| `spawn_subagent` | Spawn an independent sub-agent for a specific sub-task   |
| `send_task`      | Send a task to a running agent in a realtime session     |
| `wait_result`    | Wait for a result from an agent that was given a task    |
| `check_agents`   | Check status of all agents in the realtime session       |

## Project Structure

```
tiger_cowork/
├── server/
│   ├── index.ts                    # Fastify + Socket.IO + Vite dev server entry
│   ├── routes/
│   │   ├── chat.ts                 # Chat session CRUD + message API
│   │   ├── files.ts                # File manager (list, read, write, delete, preview)
│   │   ├── projects.ts             # Project CRUD, memory, folder browse, project files
│   │   ├── tasks.ts                # Scheduled tasks CRUD
│   │   ├── skills.ts               # Skills catalog and management
│   │   ├── settings.ts             # App settings API
│   │   ├── python.ts               # Python code execution endpoint
│   │   ├── tools.ts                # Web search, URL fetch, MCP proxy
│   │   ├── agents.ts               # Agent YAML config CRUD, parse, generate, protocol status
│   │   └── clawhub.ts              # ClawHub skill marketplace
│   └── services/
│       ├── tigerbot.ts             # LLM API client (chat, streaming, tool loop, reflection eval)
│       ├── toolbox.ts              # 12 built-in tool definitions + dispatcher
│       ├── mcp.ts                  # MCP client (connect, discover, call tools)
│       ├── socket.ts               # Real-time Socket.IO event handlers (chat + project chat)
│       ├── scheduler.ts            # Cron job scheduler (node-cron)
│       ├── data.ts                 # JSON file-based data persistence
│       ├── python.ts               # Python subprocess runner
│       ├── sandbox.ts              # Sandbox file operations
│       ├── clawhub.ts              # ClawHub marketplace service
│       └── protocols.ts            # Inter-agent communication protocol status
├── client/
│   ├── src/
│   │   ├── App.tsx                 # React Router setup
│   │   ├── main.tsx                # App entry point
│   │   ├── pages/
│   │   │   ├── ChatPage.tsx        # Main chat interface with output panel
│   │   │   └── ProjectsPage.tsx    # Project management with chat, memory, skills, files
│   │   ├── components/
│   │   │   ├── AgentEditor.tsx     # Visual multi-agent system editor (canvas, nodes, connections)
│   │   │   ├── AgentEditor.css     # Agent editor styles
│   │   │   ├── AuthGate.tsx        # Access token login gate
│   │   │   ├── Layout.tsx          # App layout with sidebar navigation
│   │   │   └── ReactComponentRenderer.tsx  # Native React component renderer
│   │   ├── hooks/                  # useSocket custom hook
│   │   └── styles/                 # Global CSS
│   ├── package.json
│   └── vite.config.ts
├── data/                           # Auto-created JSON data storage
│   ├── settings.json               # API keys, model, MCP config
│   ├── chat_history.json           # Chat sessions and messages
│   ├── projects.json               # Project definitions and memory
│   ├── tasks.json                  # Scheduled task definitions
│   ├── skills.json                 # Installed skills registry
│   └── agents/                     # Agent system YAML configurations
├── output_file/                    # Generated output files (charts, reports)
├── skills/                         # Installed ClawHub skills
├── package.json
├── tsconfig.json
└── .gitignore
```

## API Endpoints

| Method | Endpoint                           | Description                   |
|--------|------------------------------------|-------------------------------|
| POST   | `/api/auth/verify`                 | Verify access token           |
| GET    | `/api/chat/sessions`               | List all chat sessions        |
| POST   | `/api/chat/sessions`               | Create a new chat session     |
| GET    | `/api/chat/sessions/:id`           | Get session with messages     |
| DELETE | `/api/chat/sessions/:id`           | Delete a chat session         |
| PATCH  | `/api/chat/sessions/:id`           | Rename a chat session         |
| POST   | `/api/chat/sessions/:id/messages`  | Send a message                |
| GET    | `/api/projects`                    | List all projects             |
| POST   | `/api/projects`                    | Create a new project          |
| GET    | `/api/projects/:id`                | Get a project                 |
| PATCH  | `/api/projects/:id`                | Update a project              |
| DELETE | `/api/projects/:id`                | Delete a project              |
| GET    | `/api/projects/:id/memory`         | Get project memory            |
| PUT    | `/api/projects/:id/memory`         | Update project memory         |
| GET    | `/api/projects/:id/files`          | List project working folder   |
| GET    | `/api/projects/browse/folders`     | Browse filesystem folders     |
| GET    | `/api/projects/docker/mounts`     | Generate Docker volume config |
| GET    | `/api/files?path=`                 | List files in sandbox         |
| GET    | `/api/files/preview?file=`         | Preview PDF/DOCX files        |
| GET    | `/api/tasks`                       | List scheduled tasks          |
| POST   | `/api/tasks`                       | Create a scheduled task       |
| PATCH  | `/api/tasks/:id`                   | Update/toggle a task          |
| DELETE | `/api/tasks/:id`                   | Delete a task                 |
| GET    | `/api/skills`                      | List installed skills         |
| POST   | `/api/skills`                      | Install a custom skill        |
| GET    | `/api/skills/catalog`              | Browse skill catalog          |
| GET    | `/api/settings`                    | Get app settings              |
| PUT    | `/api/settings`                    | Update settings               |
| POST   | `/api/settings/test-connection`    | Test API connection           |
| POST   | `/api/python/run`                  | Execute Python code           |
| POST   | `/api/tools/web-search`            | Search the web                |
| POST   | `/api/tools/fetch`                 | Fetch a URL                   |
| GET    | `/api/clawhub/skills`              | List installed ClawHub skills |
| GET    | `/api/clawhub/search?q=`           | Search ClawHub marketplace    |
| POST   | `/api/clawhub/install`             | Install a ClawHub skill       |
| GET    | `/api/agents`                      | List all agent YAML configs   |
| GET    | `/api/agents/:filename`            | Get a specific agent config   |
| POST   | `/api/agents`                      | Save agent config (create/update) |
| DELETE | `/api/agents/:filename`            | Delete an agent config        |
| POST   | `/api/agents/parse`                | Parse YAML content            |
| POST   | `/api/agents/generate`             | Generate YAML from editor data |
| GET    | `/api/agents/protocols/status`     | Get protocol status           |

## Socket.IO Events

| Event               | Direction        | Description                          |
|---------------------|------------------|--------------------------------------|
| `chat:send`         | Client → Server  | Send a chat message                  |
| `project:chat:send` | Client → Server  | Send a project chat message          |
| `chat:chunk`        | Server → Client  | Streamed AI response chunk           |
| `chat:status`       | Server → Client  | Status update (thinking, tool call)  |
| `chat:response`     | Server → Client  | Final complete response with files   |
| `chat:subagent`     | Server → Client  | Sub-agent status (spawn, tool, done, error) |
| `chat:chunk` (realtime) | Server → Client | Realtime agent lifecycle (ready, working, tool, delegating, done) |
| `python:run`        | Client → Server  | Execute Python code                  |
| `python:status`     | Server → Client  | Python execution status              |
| `python:result`     | Server → Client  | Python execution result              |

## Agent Communication Architecture

Tiger Cowork agents communicate through four protocols and seven orchestration topologies. Understanding how agents connect, discover each other, and exchange information is key to designing effective multi-agent systems.

### How Agents Discover Each Other

Agents don't query a registry at runtime. Instead, the server loads your YAML configuration at startup and **injects the full architecture into each agent's system prompt** — every agent's name, ID, role, responsibilities, and available connections. Each agent knows who else exists and how to reach them from the moment it starts.

### Four Communication Protocols

| Protocol | Pattern | How It Works | Use Case |
|---|---|---|---|
| **TCP** | Point-to-point | Ephemeral bidirectional channels between agent pairs via localhost sockets. Newline-delimited JSON. | Direct messaging between two specific agents |
| **Bus** | Pub/Sub broadcast | In-process EventEmitter with topic-based subscriptions and 500-message history per session. | Status updates, findings broadcast to all listeners |
| **Queue** | FIFO ordered | Per-channel message queue (max 200 messages). | Sequential task delivery, ordered handoffs |
| **Blackboard** | Shared workspace | Session-scoped task board with proposals, bids, combined scoring, and an append-only audit log (P2P mode). | P2P task negotiation, Contract Net Protocol with 50/50 scoring |

Agents access these via tool calls: `proto_tcp_send`/`proto_tcp_read`, `proto_bus_publish`/`proto_bus_history`, `proto_queue_send`/`proto_queue_receive`, and `bb_propose`/`bb_bid`/`bb_award`/`bb_complete`/`bb_read`/`bb_log` (P2P blackboard).

### Task Delegation (send_task / wait_result)

The primary way agents assign work to each other:

```
Agent A                          Agent B
   │                                │
   ├── send_task({to: "agent_b",    │
   │     task: "analyze data"})     │
   │         ──── bus topic ────►   │
   │           "task:agent_b"       ├── processes task
   │                                │
   │   ◄──── bus topic ─────        ├── publishes result
   │       "result:agent_b"         │
   ├── wait_result({from:           │
   │     "agent_b"}) → gets result  │
   │                                │
```

Agents can send tasks to **multiple agents in a single response** for parallel execution.

### Seven Orchestration Topologies

Configure via `system.orchestration_mode` in your YAML:

| Mode | Description | Agent Access |
|---|---|---|
| **Hierarchical** | Human → Orchestrator → Workers. Orchestrator gatekeeps all delegation. | Only orchestrator has `send_task` to workers |
| **Hybrid** | Orchestrator controls main flow, but mesh-enabled workers can collaborate freely with peers. | Orchestrator delegates; mesh workers can `send_task` to each other |
| **Flat** | Human sends tasks directly to any agent. No orchestrator. | Human connects to all agents directly |
| **Mesh** | All agents can send tasks to any other agent. Fully connected. | Every agent gets `send_task`/`wait_result` |
| **Pipeline** | Sequential chain: agent_1 → agent_2 → agent_3. | Each agent passes output to the next |
| **P2P Swarm** | Autonomous peers self-organize via shared blackboard and Contract Net Protocol. No persistent authority. | All peers get blackboard tools + `send_task`/`wait_result` |
| **P2P Orchestrator** | Orchestrator delegates directly to connected agents OR posts tasks for bidder agents to compete on via blackboard. Combined 50/50 scoring. | Orchestrator gets both `send_task` and blackboard tools; bidders get blackboard tools |

```
More Control                                                              More Autonomy
    |                                                                          |
    Hierarchical → Pipeline → Flat → Hybrid → Mesh → P2P Orchestrator → P2P Swarm
    |                                                                          |
Single boss       Chain      Direct    Mixed    Free    Boss + bidding    Self-organizing
controls all      order      assign    mode     talk    with scoring      with consensus
```

### Mesh Networking — Peer-to-Peer Collaboration

Mesh enables agents to **autonomously request help** from other agents. When an agent receives a task and decides it needs assistance, it can delegate sub-tasks to peers without going through the orchestrator.

**Enable mesh per agent:**
```yaml
agents:
  - id: web_researcher_1
    name: Primary Researcher
    role: researcher
    mesh:
      enabled: true    # This agent can send_task to any peer
```

**Or enable globally:**
```yaml
system:
  orchestration_mode: mesh    # ALL agents can communicate freely
```

**Example — researcher asks a peer for help:**
```
Orchestrator → send_task → Researcher 1 ("investigate topic X")
    Researcher 1 starts working...
    Researcher 1 thinks: "I need statistics for this"
    Researcher 1 → send_task → Researcher 3 ("find statistics on X")
    Researcher 3 → processes and returns stats
    Researcher 1 → wait_result → combines everything
    Researcher 1 → returns final result to Orchestrator
```

**Without mesh**, a worker agent can only receive tasks and return results — it cannot ask other agents for help.

### P2P Swarm — Governed Self-Organization

P2P Swarm is the most autonomous orchestration mode. Unlike mesh (which is free-for-all), P2P adds **governance** — agents coordinate through a shared blackboard using the Contract Net Protocol with combined 50/50 scoring and an immutable audit log. For teams that need a central coordinator, use **P2P Orchestrator** mode instead.

**Key concepts:**
- **No persistent authority** — all agents are autonomous peers with role `peer`
- **Shared blackboard** — a workspace where agents post tasks, bids, and results
- **Contract Net Protocol (CNP)** — structured bidding: propose → bid → award (50/50 scoring) → execute → complete
- **Combined scoring** — winner determined by 50% bidder confidence + 50% orchestrator assessment
- **Audit log** — append-only event trail for full auditability

**Contract Net Protocol flow:**

```
1. PROPOSE  → Agent posts task on blackboard (bb_propose) — bidders auto-notified
2. BID      → Bidders submit confidence scores (bb_bid)
3. REVIEW   → Orchestrator reads bids + bidder profiles via bb_read
4. SCORE    → Orchestrator provides its own score for each bidder
5. AWARD    → Winner = 50% bidder confidence + 50% orchestrator score (bb_award)
6. SEND     → Orchestrator sends actual task to winner (send_task)
7. EXECUTE  → Winner performs the task using available tools
8. COMPLETE → Winner reports result (bb_complete)
```

**P2P blackboard tools** (available to all peer/bidder agents):

| Tool | Purpose |
|---|---|
| `bb_propose` | Post a new task on the blackboard — bidders are auto-notified and asked to bid |
| `bb_bid` | Submit a bid with confidence score (0-1) and reasoning |
| `bb_award` | Award task using combined scoring (orchestrator_scores + bidder confidence) |
| `bb_complete` | Mark a task as completed with result |
| `bb_read` | Read the blackboard — tasks, bids with bidder profiles, statuses |
| `bb_log` | Read the audit log — full event trail for auditability |

**Example YAML configuration:**

```yaml
system:
  name: Research Swarm
  orchestration_mode: p2p
  p2p_governance:
    consensus_mechanism: contract_net
    bid_timeout_seconds: 30
    min_confidence_threshold: 0.5
    audit_log: true

agents:
  - id: human
    name: User
    role: human

  - id: data_analyst
    name: Data Analyst
    role: peer
    persona: "Expert in statistical analysis and data visualization."
    responsibilities:
      - Analyze datasets and compute statistics
      - Create charts and visualizations
    bus:
      enabled: true
    p2p:
      confidence_domains:
        - statistics
        - data_visualization
      reputation_score: 0.9

  - id: web_researcher
    name: Web Researcher
    role: peer
    persona: "Skilled at finding and synthesizing information from the web."
    responsibilities:
      - Search for relevant papers and articles
      - Extract key findings from sources
    bus:
      enabled: true
    p2p:
      confidence_domains:
        - web_search
        - literature_review
      reputation_score: 0.85
```

**P2P Swarm vs Mesh:**

| | Mesh | P2P Swarm | P2P Orchestrator |
|---|---|---|---|
| Connections | None (free-for-all) | None (blackboard) | Orchestrator → direct agents + blackboard for bidders |
| Coordination | Ad-hoc direct messaging | Governed protocol (CNP) | Hybrid: direct delegation + CNP bidding |
| Task allocation | Agent decides who to ask | Competitive bidding | 50/50 combined scoring (bidder + orchestrator) |
| Auditability | Bus history only | Full audit log | Full audit log with scoring details |
| Agent role | Any (worker, researcher, etc.) | `peer` | `orchestrator` + `bidder` agents |

### Agent Roles

| Role | Color | Purpose |
|---|---|---|
| **human** | Pink | User entry point — the human interacts via this node |
| **orchestrator** | Blue | Central coordinator — decomposes tasks, delegates to workers, synthesizes results |
| **worker** | Green | Executes assigned tasks — the workhorse of hierarchical/hybrid teams |
| **checker** | Orange | Quality assurance — validates outputs from other agents |
| **reporter** | Purple | Synthesizes results into reports, summaries, and presentations |
| **researcher** | Teal | Information gathering — web search, literature review, data collection |
| **peer** | Amber | Autonomous P2P agent — self-organizes via blackboard and consensus |

### Connection Access Control

The `connections` array in YAML defines allowed communication paths:

```yaml
connections:
  - from: research_orchestrator
    to: web_researcher_1
    label: search_task
    protocol: tcp
  - from: web_researcher_1
    to: research_synthesizer
    label: deliver_findings
    protocol: queue
    topics:
      - raw_findings
```

**Access rules enforced at runtime:**

| Condition | Can `send_task`? |
|---|---|
| Agent has `mesh.enabled: true` | Yes — to any peer |
| Global `orchestration_mode: mesh` | Yes — to any peer |
| Global `orchestration_mode: p2p` | Yes — to any peer (+ blackboard tools) |
| Global `orchestration_mode: p2p_orchestrator` + orchestrator role | Yes — to connected agents directly; bidder-only agents require blackboard bidding first |
| Agent has explicit `outputs_to` or `connections` to target | Yes — to listed targets only |
| Hybrid orchestrator | Yes — to connected agents |
| None of the above | No — `send_task` tool is not available |

### Bus Topics

Agents configured with `bus.enabled: true` can publish and subscribe to topics. Some bus activity is **automatic**:

| Bus Topic | When Published | By Whom |
|---|---|---|
| `task:{agent_id}` | When a task is sent to an agent | System (via `send_task`) |
| `result:{agent_id}` | When an agent completes a task | System (automatic) |
| Custom topics (e.g. `raw_findings`) | When an agent decides to broadcast | Agent (via `proto_bus_publish`) |

### Talking to Agents Directly (`/agent` command)

During a running realtime session, you can talk to specific agents directly from the chat:

```
/agent research_orchestrator "analyze the impact of climate change on soil mechanics"
```

Or use the agent's display name (case-insensitive):

```
/agent "Literature Researcher" "find recent papers on SANISAND model"
```

**Broadcast to all connected agents** (omit the agent name):

```
/agent "summarize your current findings"
```

**Access control:** The human can only talk to agents connected to the human node.

### Local CLI Agent Setup

Use **Claude Code** or **Codex** as autonomous agent backends — they handle code reading, editing, and execution with their own tool loops. No API key needed.

**Claude Code:**
```bash
npm install -g @anthropic-ai/claude-code
claude          # one-time OAuth login
claude -p "hello" --output-format json
```

**OpenAI Codex:**
```bash
npm install -g @openai/codex
codex login     # one-time OAuth login
codex exec "hello"
```

**Use in Tiger Cowork:**
1. Open the Agent Editor → select an agent → check "Specify model for this agent"
2. Choose Claude Code (Local CLI), Codex (Local CLI), or any API model
3. Each agent runs on its assigned backend

**Headless server (no browser):** authenticate on another machine, then copy credentials:
```bash
scp -r ~/.claude user@server:~/.claude   # Claude Code
scp -r ~/.codex user@server:~/.codex     # Codex
```

### MCP Server Setup

Connect external **Model Context Protocol** servers to extend the AI's toolbox. Supports **StreamableHTTP**, **SSE**, and **Stdio** transports.

Configure in **Settings** → **MCP Servers**:

```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer your-token" },
      "enabled": true
    },
    "local-files": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"],
      "enabled": true
    }
  }
}
```

Connected tools appear automatically alongside built-in tools with the naming pattern `mcp_{serverName}_{toolName}`.

### Context Management Settings

| Setting | Default | Description |
|---|---|---|
| `agentCompressionInterval` | `5` | Compress older messages every N tool loop rounds |
| `agentCompressionWindowSize` | `10` | Number of recent messages to keep uncompressed |
| `agentCompressionModel` | *(main model)* | Optional cheaper/faster model for compression |
| `agentCheckpointEnabled` | `true` | Enable automatic checkpoint saving for crash recovery |
| `agentCheckpointInterval` | `5` | Save checkpoint every N rounds |
| `agentToolResultMaxLen` | `6000` | Max chars per tool result (hard-capped at 100KB) |
| `agentMaxToolRounds` | `8` | Max iterations of the tool-calling loop |
| `agentMaxToolCalls` | `12` | Total tool calls allowed per session |

### Design Tips

- **Use `hierarchical` mode** for strict control — the orchestrator is the single point of delegation.
- **Use `hybrid` mode** when you want structured orchestration but also want specialist agents to collaborate freely.
- **Use `mesh` mode** for flat, fully connected teams where any agent can ask any other for help.
- **Use `p2p` mode** when agents have diverse specialties and you want them to self-organize via competitive bidding.
- **Use `p2p_orchestrator` mode** when you want a central coordinator with competitive task allocation using 50/50 scoring.
- **Add `mesh.enabled: true`** to any agent that might need to request help mid-task.
- **Bus topics** are useful for monitoring — watch `proto_bus_history` to see what all agents are doing.
- **P2P confidence_domains** — set distinct expertise domains per peer agent so they bid accurately.
