# Changelog

## v0.4.3 (2026-04-02)
**P2P Swarm Governance**

- **P2P Swarm orchestration mode** — New `p2p` orchestration topology where autonomous peer agents self-organize via a shared blackboard. No persistent authority — agents propose tasks, bid with confidence scores, and the best-suited agent wins the work through Contract Net Protocol.
- **P2P Orchestrator mode** — New `p2p_orchestrator` topology combining hierarchical control with P2P bidding. The orchestrator can delegate directly to connected agents OR post tasks to the blackboard for bidder agents to compete on. Bidder agents without direct connections are only reachable through the bidding workflow.
- **Combined scoring (50/50)** — Final winner = 50% bidder's self-reported confidence + 50% orchestrator's assessment score. The orchestrator sees each bidder's persona, expertise domains, responsibilities, and reputation when making its judgment.
- **Blackboard protocol** — Fourth communication protocol alongside TCP, Bus, and Queue. Session-scoped shared workspace with proposals, bids, results, and an append-only audit log.
- **Active bidder wake-up** — When a task is proposed on the blackboard, bidder agents are automatically woken up and asked to bid via bus notification.
- **Bidder access control** — In `p2p_orchestrator` mode, the orchestrator cannot bypass bidding by sending tasks directly to bidder-only agents. The system enforces: propose → bid → award → send_task.
- **Peer agent role** — New `peer` role for P2P swarm agents with per-agent `confidence_domains` and `reputation_score` (0-1). Shown with amber color and PEER badge in the editor.
- **BIDDER badge** — Agents marked as P2P bidders show a cyan BIDDER badge on their node in the editor.
- **Mesh-enabled bidders** — Bidder agents with `mesh.enabled: true` can delegate sub-tasks to other agents after winning work.
- **P2P Governance panel** — Visual configuration in the Agent Editor for bid timeout, minimum confidence threshold, max retries, and audit log toggle.
- **Six blackboard tools** — `bb_propose`, `bb_bid`, `bb_award`, `bb_complete`, `bb_read`, `bb_log` — injected into peer/bidder agents' toolbox automatically.
- **Auto Architecture support** — The AI architect can now generate complete P2P swarm configurations from natural language descriptions.

## v0.4.2
**MiniMax Built-in Provider**

- **MiniMax as built-in AI provider** — MiniMax is now available as a default provider in the Settings dropdown (URL: api.minimax.io/v1, Model: MiniMax-M2.7). No need to manually add it as a custom provider.

## v0.4.1
**Per-Agent Model Selection & CLI Agent Backends**

- **Per-agent model & provider selection** — Each agent in your architecture can run on a different model or backend. In the Agent Editor, check "Specify model for this agent" and pick any model — API-based or local CLI.
- **Claude Code & Codex as code agents (OAuth)** — Set any agent to "Claude Code (Local CLI)" or "Codex (Local CLI)". These run as fully autonomous coding agents with their own tool loops. No API key needed — they authenticate via OAuth.
- **Agent waiting/done states** — Task monitor now shows running, waiting, and done agents with distinct visual states and icons.
- **Anti-abandonment nudges** — Prevents the LLM from stopping while sub-agents are still working or when responses sound incomplete.
- **Python auto-retry** — Automatically fixes common syntax errors and retries.
- **Max context tokens setting** — Configure the token threshold for auto-compaction in Settings.

## v0.4.0 (2026-03-30)
**Major release: Full Parallel Agent Execution**

- **Parallel agent execution** — `wait_result` added to `parallelToolNames` so multiple agent results are awaited simultaneously via `Promise.all` instead of sequentially. Agents that previously appeared to run one-at-a-time now truly work in parallel.
- **Per-task context isolation** — Replaced global `_currentParentSessionId`/`_currentAgentId`/`_currentSubagentDepth`/`_currentProjectWorkingFolder` with a `Map<string, CallContext>` keyed by taskId. `callTool()` accepts optional `taskId` to read from the correct context. Concurrent tasks no longer corrupt each other's state.
- **Parallel task UI** — Removed `isLoading` send-blocking guard from ChatPage. Users can now send multiple messages while agents are working. Input, textarea, and attach button remain enabled during task execution. Status bar shows running task count.
- **Direct orchestrator bypass** — When realtime mode is active and the YAML config has an orchestrator role agent, user messages are published directly to the orchestrator via bus, skipping the main LLM `callTigerBotWithTools` call entirely. Falls back to normal flow on timeout. Saves one full LLM API call per user message.
- **Live task monitor redesign** — 8-color agent palette with stable hash-based assignment. Active agents shown as colored pills with animated pulsing dots. Agent tool rows have colored left borders, background highlights when active, play/checkmark status icons, and per-agent tool call counts. Polling reduced from 5s to 2s with socket-driven instant refresh on tool calls and agent events.
- **Multi-agent tracking** — `activeAgent` (single string) replaced with `activeAgents` (Set) on the server. Multiple agents working simultaneously are now properly tracked and displayed. Finished agents are removed from the active set instead of resetting to "Orchestrator".
- **Task-to-chat navigation** — Task page cards now include a "Chat" button that navigates to `/?session=<id>`. ChatPage reads `?session=` query param to auto-select the corresponding chat session.
- **`callTigerBotWithTools` taskId parameter** — New optional `taskId` parameter threaded through `callTigerBotWithTools` → `callTool` for per-task context resolution. Both `chat:send` and `project:chat:send` handlers pass taskId and call `clearCallContext(taskId)` in finally blocks.

## v0.3.2 (2026-03-23)
- Add **per-agent Mesh checkbox** — individual agents can be marked as "mesh enabled" to freely send tasks to any other agent without needing connection lines, similar to the Bus checkbox for broadcast data sharing
- Add **Hybrid architecture mode** — combines an orchestrator (controls flow via TCP connections) with mesh-enabled workers (collaborate freely as peers); orchestrator auto-receives bus tools to monitor all agent activity and prevent infinite loops
- Add **config file name display** in chat header — shows the active YAML architecture file name next to the Realtime Agent / Swarm tag
- Change connection line protocols to **TCP and Queue only** — removed Bus as a connection protocol since bus access is controlled per-agent via the Bus checkbox, not via connection lines
- Change **Mesh from global mode to per-agent** — instead of a global orchestration mode, each agent individually opts into mesh via checkbox; global Mesh mode still available for all-agents-free-talk scenarios
- Add per-agent mesh access control: mesh-enabled agents bypass connection validation in `send_task`; non-mesh agents must use explicit connections
- Add mesh-aware tool assignment: mesh agents receive `send_task`/`wait_result` tools with full peer list even without explicit downstream connections
- Add `mesh` field to `AgentConfig` interface and YAML schema (`mesh: { enabled: true }`)
- Update auto-architecture LLM prompt with connection policy (TCP/Queue only), bus policy (checkbox only), mesh policy (per-agent), and hybrid architecture rules
- Fix **agent config delete** not working — Fastify 5 rejected DELETE requests with empty JSON body; now only sets `Content-Type: application/json` when request has a body

## v0.3.1 (2026-03-22)
- Add **Human Node** role — new "human" agent role that acts as the user's entry point in realtime agent graphs without running an LLM loop
- Add **`/agent` command** for direct agent communication: `/agent [name] "prompt"` (targeted) or `/agent "prompt"` (broadcast to all connected agents)
- Add **human-to-agent and agent-to-human messaging** — human node loop listens for agent outputs and forwards to chat UI with attribution tags
- Add human node UI in Agent Editor — dedicated styling, info panel, hidden AI-setup and model fields for human role
- Add `getHumanConnectedAgents`, `humanSendToAgent`, `humanBroadcastToAgents`, `humanWaitForAgent` helpers in toolbox service
- Add drawing-analyzer v2.1.0 to ClawHub plugin registry

## v0.3.0 (2026-03-21)
**Major rewrite: Express → Fastify async-first framework**

- **Fastify 5** replaces Express.js — natively async handlers, ~2x faster request throughput, built-in Pino structured logging
- **Async file I/O everywhere** — All data layer and sandbox operations converted from synchronous `fs.*Sync` to async `fs/promises`
- **Plugin architecture** — All 10 route files converted from Express `Router()` to Fastify async plugins with scoped hooks
- **@fastify/multipart** replaces `multer` — async file upload handling
- **@fastify/static** replaces `express.static()`
- **@fastify/cors** replaces `cors` middleware
- **@fastify/middie** bridges Vite dev middleware for HMR
- **Native PDF preview** — PDF files render inline using the browser's native PDF viewer
- **Abort signal propagation** — Kill task now immediately cancels blocking `wait_result` and `send_task` calls
- **React output path fix** — `run_react` tool now returns correct sandbox-relative paths in project context

## v0.2.4
- Rich file preview in file browser (images, HTML, Excel, PDF, Word, Markdown, video/audio)
- Auto-generate project memory from chat via LLM
- LLM-powered agent definition generator
- Agent model validation
- Project file browser with preview panel

## v0.2.3
- Windows installer (`TigerCoworkInstaller.bat`)
- Docker Desktop prerequisite with download links
- Sandbox 401 fix for fresh installs
- Docker image includes Python3

## v0.2.2
- **Realtime Agent Mode** — all agents boot at session start for true parallel execution
- New orchestrator tools: `send_task`, `wait_result`, `check_agents`
- Bus toggle per agent in Agent Editor
- Protocol-aware tool filtering
- Agent Editor file manager
- Port-based connection drawing
- Free-text model input
- Renamed "Manual" to "Spawn Agent"

## v0.2.1
- **Agent System Editor** — visual drag-and-drop canvas for multi-agent systems
- AI-assisted agent setup
- Four orchestration modes: Hierarchical, Flat, Mesh, Pipeline
- YAML export with full system metadata

## v0.2.0
- **Sub-Agent System** — spawn independent child agents with own tool loops
- New tool: `spawn_subagent`
- Real-time sub-agent status via Socket.IO
- Depth-aware tool filtering

## v0.1.5
- **Agent Reflection Loop** — self-evaluation with auto-retry
- Fix: reflection block was unreachable due to early `return`

## v0.1.4
- Working folder: Sandbox vs External with access levels
- Docker volume mount generator
- Configurable agent parameters

## v0.1.3
- Projects feature with working folder, memory, skill selection, file browser
- Output panel for project chat
- Word/PDF document preview
- Image attachment support

## v0.1.2
- Access token authentication
- Context overflow fix
- Tool loop reliability improvements
- `ReactComponentRenderer` for native React rendering
- MCP integration (Stdio/SSE/StreamableHTTP)

## v0.1.1
- Tool loop reliability and chart generation improvements

## v0.1.0
- Initial release: Express + Vite web app with AI chat, file manager, Python execution, scheduled tasks, skills marketplace, and web search
