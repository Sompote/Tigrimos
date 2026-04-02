/**
 * Inter-agent communication protocols: TCP, Bus, Queue
 *
 * These are real in-process implementations that sub-agents use to
 * exchange messages during execution.
 *
 *  - TCP:   Point-to-point bidirectional channel via Node net server/client on localhost
 *  - Bus:   In-process pub/sub event bus (topics)
 *  - Queue: FIFO message queue with persistence per channel
 */

import net from "net";
import { EventEmitter } from "events";
import { appendAgentHistory, readAgentHistory } from "./data";

// ─── Types ───

export interface ProtocolMessage {
  from: string;      // sender agent id
  to?: string;       // recipient agent id (optional for bus broadcast)
  topic: string;
  payload: any;
  timestamp: string;
}

// ─── TCP Protocol ───
// Creates ephemeral localhost TCP servers per agent pair for bidirectional messaging.

interface TcpChannel {
  server: net.Server;
  port: number;
  buffer: ProtocolMessage[];
  clients: net.Socket[];
}

const tcpChannels = new Map<string, TcpChannel>();
const tcpChannelSessions = new Map<string, string>(); // channelKey -> sessionId

function tcpChannelKey(from: string, to: string): string {
  return [from, to].sort().join("<->"); // bidirectional
}

export async function tcpOpen(agentA: string, agentB: string, sessionId?: string): Promise<{ port: number; channelId: string }> {
  const key = tcpChannelKey(agentA, agentB);
  if (tcpChannels.has(key)) {
    const ch = tcpChannels.get(key)!;
    return { port: ch.port, channelId: key };
  }

  return new Promise((resolve, reject) => {
    const buffer: ProtocolMessage[] = [];
    const clients: net.Socket[] = [];

    const server = net.createServer((socket) => {
      clients.push(socket);
      let pending = "";

      socket.on("data", (data) => {
        pending += data.toString();
        // Messages are newline-delimited JSON
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg: ProtocolMessage = JSON.parse(line);
            msg.timestamp = msg.timestamp || new Date().toISOString();
            buffer.push(msg);
            // Persist to agent history
            const sid = tcpChannelSessions.get(key);
            if (sid) appendAgentHistory(sid, "tcp.jsonl", msg).catch(() => {});
            // Forward to other connected clients
            for (const c of clients) {
              if (c !== socket && !c.destroyed) {
                c.write(line + "\n");
              }
            }
          } catch {}
        }
      });

      socket.on("close", () => {
        const idx = clients.indexOf(socket);
        if (idx >= 0) clients.splice(idx, 1);
      });

      socket.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const channel: TcpChannel = { server, port: addr.port, buffer, clients };
      tcpChannels.set(key, channel);
      if (sessionId) tcpChannelSessions.set(key, sessionId);
      console.log(`[Protocol:TCP] Channel ${key} opened on port ${addr.port}`);
      resolve({ port: addr.port, channelId: key });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export async function tcpSend(agentFrom: string, agentTo: string, topic: string, payload: any): Promise<boolean> {
  const key = tcpChannelKey(agentFrom, agentTo);
  const ch = tcpChannels.get(key);
  if (!ch) return false;

  const msg: ProtocolMessage = {
    from: agentFrom,
    to: agentTo,
    topic,
    payload,
    timestamp: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    const client = net.createConnection({ port: ch.port, host: "127.0.0.1" }, () => {
      client.write(JSON.stringify(msg) + "\n");
      client.end();
      resolve(true);
    });
    client.on("error", () => resolve(false));
  });
}

export function tcpRead(agentA: string, agentB: string): ProtocolMessage[] {
  const key = tcpChannelKey(agentA, agentB);
  const ch = tcpChannels.get(key);
  return ch ? [...ch.buffer] : [];
}

export function tcpClose(agentA: string, agentB: string): void {
  const key = tcpChannelKey(agentA, agentB);
  const ch = tcpChannels.get(key);
  if (ch) {
    for (const c of ch.clients) c.destroy();
    ch.server.close();
    tcpChannels.delete(key);
    tcpChannelSessions.delete(key);
    console.log(`[Protocol:TCP] Channel ${key} closed`);
  }
}

// ─── Bus Protocol ───
// In-process pub/sub event bus. Agents subscribe to topics and broadcast.

class AgentBus extends EventEmitter {
  private history: ProtocolMessage[] = [];
  private maxHistory = 500;

  publish(msg: ProtocolMessage): void {
    msg.timestamp = msg.timestamp || new Date().toISOString();
    this.history.push(msg);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.emit(`topic:${msg.topic}`, msg);
    this.emit("message", msg);
  }

  subscribe(topic: string, handler: (msg: ProtocolMessage) => void): () => void {
    this.on(`topic:${topic}`, handler);
    return () => this.off(`topic:${topic}`, handler);
  }

  getHistory(topic?: string): ProtocolMessage[] {
    if (topic) return this.history.filter((m) => m.topic === topic);
    return [...this.history];
  }

  loadHistory(msgs: ProtocolMessage[]): void {
    for (const msg of msgs) {
      this.history.push(msg);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
  }

  clear(): void {
    this.history = [];
    this.removeAllListeners();
  }
}

// One bus per session/system
const busInstances = new Map<string, AgentBus>();

export function busGet(sessionId: string): AgentBus {
  if (!busInstances.has(sessionId)) {
    busInstances.set(sessionId, new AgentBus());
    console.log(`[Protocol:Bus] Created bus for session ${sessionId}`);
  }
  return busInstances.get(sessionId)!;
}

export function busPublish(sessionId: string, from: string, topic: string, payload: any): void {
  const bus = busGet(sessionId);
  const msg: ProtocolMessage = { from, topic, payload, timestamp: new Date().toISOString() };
  bus.publish(msg);
  appendAgentHistory(sessionId, "bus.jsonl", msg).catch(() => {});
}

export function busSubscribe(sessionId: string, topic: string, handler: (msg: ProtocolMessage) => void): () => void {
  const bus = busGet(sessionId);
  return bus.subscribe(topic, handler);
}

export function busHistory(sessionId: string, topic?: string): ProtocolMessage[] {
  const bus = busGet(sessionId);
  return bus.getHistory(topic);
}

export async function busLoadHistory(sessionId: string): Promise<number> {
  const bus = busGet(sessionId);
  const saved = await readAgentHistory(sessionId, "bus.jsonl");
  if (saved.length > 0) {
    bus.loadHistory(saved);
  }
  return saved.length;
}

export function busDestroy(sessionId: string): void {
  const bus = busInstances.get(sessionId);
  if (bus) {
    bus.clear();
    busInstances.delete(sessionId);
    console.log(`[Protocol:Bus] Destroyed bus for session ${sessionId}`);
  }
}

// ─── Queue Protocol ───
// Per-channel FIFO message queue. Producers enqueue, consumers dequeue.

interface MessageQueue {
  messages: ProtocolMessage[];
  maxSize: number;
}

const queues = new Map<string, MessageQueue>();

function queueKey(from: string, to: string, topic?: string): string {
  return `${from}->${to}${topic ? `:${topic}` : ""}`;
}

export function queueEnqueue(from: string, to: string, topic: string, payload: any, sessionId?: string): number {
  const key = queueKey(from, to, topic);
  if (!queues.has(key)) {
    queues.set(key, { messages: [], maxSize: 200 });
  }
  const q = queues.get(key)!;
  const msg: ProtocolMessage = {
    from,
    to,
    topic,
    payload,
    timestamp: new Date().toISOString(),
  };
  q.messages.push(msg);
  if (q.messages.length > q.maxSize) q.messages.shift();
  if (sessionId) appendAgentHistory(sessionId, "queue.jsonl", msg).catch(() => {});
  console.log(`[Protocol:Queue] Enqueued ${key} (depth=${q.messages.length})`);
  return q.messages.length;
}

export function queueDequeue(from: string, to: string, topic?: string): ProtocolMessage | null {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  if (!q || q.messages.length === 0) return null;
  return q.messages.shift()!;
}

export function queuePeek(from: string, to: string, topic?: string, count: number = 5): ProtocolMessage[] {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  if (!q) return [];
  return q.messages.slice(0, count);
}

export function queueDepth(from: string, to: string, topic?: string): number {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  return q ? q.messages.length : 0;
}

export function queueDrain(from: string, to: string, topic?: string): ProtocolMessage[] {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  if (!q) return [];
  const all = q.messages.splice(0);
  console.log(`[Protocol:Queue] Drained ${key} (${all.length} messages)`);
  return all;
}

export function queueClear(from: string, to: string, topic?: string): void {
  const key = queueKey(from, to, topic);
  queues.delete(key);
}

// ─── Bus Helpers ───

/**
 * Wait for the next message on a bus topic. Returns a Promise that resolves
 * when a message arrives, or rejects on timeout / abort.
 */
export function busWaitForMessage(
  sessionId: string,
  topic: string,
  timeoutMs: number = 120000,
  signal?: AbortSignal,
): Promise<ProtocolMessage> {
  return new Promise((resolve, reject) => {
    const bus = busGet(sessionId);
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      unsub();
      if (timer) clearTimeout(timer);
    };

    const unsub = bus.subscribe(topic, (msg) => {
      cleanup();
      resolve(msg);
    });

    // timeoutMs <= 0 means wait indefinitely (only abort signal can cancel)
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`busWaitForMessage timeout (${timeoutMs}ms) on topic "${topic}"`));
        }, timeoutMs)
      : null;

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("aborted"));
      }, { once: true });
    }
  });
}

// ─── Blackboard Protocol (P2P Governance) ───
// Shared workspace for P2P agent swarms. Agents post proposals, bids, votes,
// and task results. Implements Contract Net Protocol and consensus mechanisms.

export interface BlackboardEntry {
  id: string;
  type: "proposal" | "bid" | "vote" | "result" | "status";
  taskId: string;
  agentId: string;
  timestamp: string;
  payload: any;
}

export interface BlackboardTask {
  taskId: string;
  description: string;
  status: "open" | "bidding" | "awarded" | "in_progress" | "completed" | "failed";
  proposedBy: string;
  proposedAt: string;
  bids: { agentId: string; confidence: number; cost?: number; reasoning?: string; timestamp: string }[];
  awardedTo?: string;
  awardedAt?: string;
  result?: any;
  completedAt?: string;
  votes: { agentId: string; vote: "approve" | "reject" | "abstain"; weight?: number; timestamp: string }[];
  consensusMechanism?: string;
}

class Blackboard {
  private tasks = new Map<string, BlackboardTask>();
  private log: BlackboardEntry[] = [];
  private maxLog = 1000;
  private taskCounter = 0;

  /** Propose a new task for the swarm to bid on.
   *  If a task with the same taskId already exists AND is completed/in_progress,
   *  skip re-proposal to prevent duplicate work after orchestrator re-dispatch. */
  propose(agentId: string, description: string, taskId?: string): BlackboardTask & { skipped?: boolean } {
    const id = taskId || `T${++this.taskCounter}_${Date.now().toString(36)}`;

    // Guard: don't re-propose tasks that are already done or in progress
    const existing = this.tasks.get(id);
    if (existing) {
      if (existing.status === "completed") {
        console.log(`[Blackboard] Task "${id}" already completed — skipping re-proposal`);
        return { ...existing, skipped: true };
      }
      if (existing.status === "in_progress" || existing.status === "awarded" || existing.status === "bidding") {
        console.log(`[Blackboard] Task "${id}" already ${existing.status} — skipping re-proposal`);
        return { ...existing, skipped: true };
      }
      // If task previously failed, allow re-proposal but reset bids
      if (existing.status === "failed") {
        console.log(`[Blackboard] Task "${id}" previously failed — re-opening for bids`);
        existing.status = "open";
        existing.bids = [];
        existing.awardedTo = undefined;
        existing.awardedAt = undefined;
        existing.result = undefined;
        existing.completedAt = undefined;
        this.appendLog({ id: `e_${Date.now()}`, type: "proposal", taskId: id, agentId, timestamp: new Date().toISOString(), payload: { description, reopen: true } });
        return existing;
      }
    }

    const task: BlackboardTask = {
      taskId: id,
      description,
      status: "open",
      proposedBy: agentId,
      proposedAt: new Date().toISOString(),
      bids: [],
      votes: [],
    };
    this.tasks.set(id, task);
    this.appendLog({ id: `e_${Date.now()}`, type: "proposal", taskId: id, agentId, timestamp: task.proposedAt, payload: { description } });
    return task;
  }

  /** Submit a bid for a task (Contract Net Protocol) */
  bid(agentId: string, taskId: string, confidence: number, cost?: number, reasoning?: string): { ok: boolean; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Task "${taskId}" not found` };
    if (task.status !== "open" && task.status !== "bidding") return { ok: false, error: `Task "${taskId}" is ${task.status}, not accepting bids` };
    // Prevent duplicate bids from same agent
    if (task.bids.some(b => b.agentId === agentId)) return { ok: false, error: `Agent "${agentId}" already bid on "${taskId}"` };
    task.status = "bidding";
    const bidEntry = { agentId, confidence, cost, reasoning, timestamp: new Date().toISOString() };
    task.bids.push(bidEntry);
    this.appendLog({ id: `e_${Date.now()}`, type: "bid", taskId, agentId, timestamp: bidEntry.timestamp, payload: bidEntry });
    return { ok: true };
  }

  /** Award a task to the best bidder (by confidence score, or specified agent) */
  award(taskId: string, awardTo?: string, mechanism?: string): { ok: boolean; awardedTo?: string; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Task "${taskId}" not found` };
    if (task.bids.length === 0) return { ok: false, error: `No bids on task "${taskId}"` };

    let winner: string;
    if (awardTo) {
      if (!task.bids.some(b => b.agentId === awardTo)) return { ok: false, error: `Agent "${awardTo}" did not bid on "${taskId}"` };
      winner = awardTo;
    } else {
      // Default: highest confidence wins (weighted_max)
      const best = task.bids.reduce((a, b) => a.confidence >= b.confidence ? a : b);
      winner = best.agentId;
    }

    task.awardedTo = winner;
    task.awardedAt = new Date().toISOString();
    task.status = "awarded";
    task.consensusMechanism = mechanism || "weighted_max";

    this.appendLog({
      id: `e_${Date.now()}`, type: "status", taskId, agentId: winner,
      timestamp: task.awardedAt,
      payload: {
        event: "BID_ACCEPTED",
        awardedTo: winner,
        competing_bids: task.bids.map(b => ({ agent: b.agentId, confidence: b.confidence })),
        consensus_mechanism: task.consensusMechanism,
      },
    });
    return { ok: true, awardedTo: winner };
  }

  /** Cast a vote on a task (for majority/weighted voting consensus) */
  vote(agentId: string, taskId: string, voteValue: "approve" | "reject" | "abstain", weight?: number): { ok: boolean; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Task "${taskId}" not found` };
    if (task.votes.some(v => v.agentId === agentId)) return { ok: false, error: `Agent "${agentId}" already voted on "${taskId}"` };
    const entry = { agentId, vote: voteValue, weight: weight || 1, timestamp: new Date().toISOString() };
    task.votes.push(entry);
    this.appendLog({ id: `e_${Date.now()}`, type: "vote", taskId, agentId, timestamp: entry.timestamp, payload: entry });
    return { ok: true };
  }

  /** Get consensus result for a task's votes */
  getConsensus(taskId: string): { approved: boolean; approveWeight: number; rejectWeight: number; totalVotes: number } | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const approveWeight = task.votes.filter(v => v.vote === "approve").reduce((s, v) => s + (v.weight || 1), 0);
    const rejectWeight = task.votes.filter(v => v.vote === "reject").reduce((s, v) => s + (v.weight || 1), 0);
    return { approved: approveWeight > rejectWeight, approveWeight, rejectWeight, totalVotes: task.votes.length };
  }

  /** Mark task as in_progress (agent starts working) */
  startTask(agentId: string, taskId: string): { ok: boolean; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Task "${taskId}" not found` };
    if (task.awardedTo !== agentId) return { ok: false, error: `Task "${taskId}" not awarded to "${agentId}"` };
    task.status = "in_progress";
    this.appendLog({ id: `e_${Date.now()}`, type: "status", taskId, agentId, timestamp: new Date().toISOString(), payload: { event: "TASK_STARTED" } });
    return { ok: true };
  }

  /** Complete a task with a result */
  completeTask(agentId: string, taskId: string, result: any): { ok: boolean; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: `Task "${taskId}" not found` };
    task.status = "completed";
    task.result = result;
    task.completedAt = new Date().toISOString();
    this.appendLog({ id: `e_${Date.now()}`, type: "result", taskId, agentId, timestamp: task.completedAt, payload: { result } });
    return { ok: true };
  }

  /** Read a task */
  getTask(taskId: string): BlackboardTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Read all tasks (optionally filtered by status) */
  getTasks(status?: string): BlackboardTask[] {
    const all = Array.from(this.tasks.values());
    return status ? all.filter(t => t.status === status) : all;
  }

  /** Read the full audit log */
  getLog(limit?: number): BlackboardEntry[] {
    return limit ? this.log.slice(-limit) : [...this.log];
  }

  clear(): void {
    this.tasks.clear();
    this.log = [];
    this.taskCounter = 0;
  }

  private appendLog(entry: BlackboardEntry): void {
    this.log.push(entry);
    if (this.log.length > this.maxLog) this.log.shift();
  }
}

// One blackboard per session
const blackboards = new Map<string, Blackboard>();

export function blackboardGet(sessionId: string): Blackboard {
  if (!blackboards.has(sessionId)) {
    blackboards.set(sessionId, new Blackboard());
    console.log(`[Protocol:Blackboard] Created blackboard for session ${sessionId}`);
  }
  return blackboards.get(sessionId)!;
}

export function blackboardPropose(sessionId: string, agentId: string, description: string, taskId?: string): BlackboardTask {
  return blackboardGet(sessionId).propose(agentId, description, taskId);
}

export function blackboardBid(sessionId: string, agentId: string, taskId: string, confidence: number, cost?: number, reasoning?: string) {
  return blackboardGet(sessionId).bid(agentId, taskId, confidence, cost, reasoning);
}

export function blackboardAward(sessionId: string, taskId: string, awardTo?: string, mechanism?: string) {
  return blackboardGet(sessionId).award(taskId, awardTo, mechanism);
}

export function blackboardVote(sessionId: string, agentId: string, taskId: string, vote: "approve" | "reject" | "abstain", weight?: number) {
  return blackboardGet(sessionId).vote(agentId, taskId, vote, weight);
}

export function blackboardStartTask(sessionId: string, agentId: string, taskId: string) {
  return blackboardGet(sessionId).startTask(agentId, taskId);
}

export function blackboardCompleteTask(sessionId: string, agentId: string, taskId: string, result: any) {
  return blackboardGet(sessionId).completeTask(agentId, taskId, result);
}

export function blackboardGetTask(sessionId: string, taskId: string) {
  return blackboardGet(sessionId).getTask(taskId);
}

export function blackboardGetTasks(sessionId: string, status?: string) {
  return blackboardGet(sessionId).getTasks(status);
}

export function blackboardGetConsensus(sessionId: string, taskId: string) {
  return blackboardGet(sessionId).getConsensus(taskId);
}

export function blackboardGetLog(sessionId: string, limit?: number) {
  return blackboardGet(sessionId).getLog(limit);
}

export function blackboardDestroy(sessionId: string): void {
  const bb = blackboards.get(sessionId);
  if (bb) {
    bb.clear();
    blackboards.delete(sessionId);
    console.log(`[Protocol:Blackboard] Destroyed blackboard for session ${sessionId}`);
  }
}

// ─── Cleanup ───
// Call this when a session ends to free all protocol resources

export function cleanupSessionProtocols(sessionId: string): void {
  busDestroy(sessionId);
  blackboardDestroy(sessionId);
  // Clean TCP channels that include session-scoped agents
  for (const [key, ch] of tcpChannels.entries()) {
    if (key.includes(sessionId)) {
      for (const c of ch.clients) c.destroy();
      ch.server.close();
      tcpChannels.delete(key);
    }
  }
}

// ─── Status / Debug ───

export function getProtocolStatus(): {
  tcp: { channels: number; details: { id: string; port: number; buffered: number }[] };
  bus: { sessions: number; details: { session: string; history: number }[] };
  queue: { channels: number; details: { id: string; depth: number }[] };
  blackboard: { sessions: number; details: { session: string; tasks: number; log: number }[] };
} {
  return {
    tcp: {
      channels: tcpChannels.size,
      details: Array.from(tcpChannels.entries()).map(([id, ch]) => ({
        id, port: ch.port, buffered: ch.buffer.length,
      })),
    },
    bus: {
      sessions: busInstances.size,
      details: Array.from(busInstances.entries()).map(([session, bus]) => ({
        session, history: bus.getHistory().length,
      })),
    },
    queue: {
      channels: queues.size,
      details: Array.from(queues.entries()).map(([id, q]) => ({
        id, depth: q.messages.length,
      })),
    },
    blackboard: {
      sessions: blackboards.size,
      details: Array.from(blackboards.entries()).map(([session, bb]) => ({
        session, tasks: bb.getTasks().length, log: bb.getLog().length,
      })),
    },
  };
}
