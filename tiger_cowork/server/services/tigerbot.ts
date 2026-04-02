import { getSettings, getCheckpointDir } from "./data";
import { getTools, callTool, getWorkingAgents, collectPendingResults, getPendingBlackboardTasks, isClaudeCodeModel, runClaudeCodeAgent, isCodexModel, runCodexAgent, isLocalCliAgent, extractCliSubModel } from "./toolbox";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: any[];
  tool_call_id?: string;
}

/**
 * Estimate the total character size of a messages array.
 */
export function estimateMessagesChars(messages: Array<{ content: any; tool_calls?: any[]; [k: string]: any }>): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text" && part.text) total += part.text.length;
        else if (part.type === "image_url") total += 2000;
      }
    }
    if (m.tool_calls) total += JSON.stringify(m.tool_calls).length;
  }
  return total;
}

/**
 * Trim conversation messages to fit within a character budget.
 * Keeps the system prompt + most recent messages, drops older ones.
 * Default ~6M chars ≈ ~1.5M tokens, safe for Grok 2M context with room for response.
 */
export function trimConversationContext(
  messages: Array<{ role: string; content: any; [k: string]: any }>,
  maxChars: number = 6_000_000
): Array<{ role: string; content: any; [k: string]: any }> {
  const totalChars = estimateMessagesChars(messages);
  if (totalChars <= maxChars) return messages;

  const result: typeof messages = [];
  let usedChars = 0;

  // Keep system messages from the start
  let startIdx = 0;
  while (startIdx < messages.length && messages[startIdx].role === "system") {
    const c = typeof messages[startIdx].content === "string" ? messages[startIdx].content.length : 500;
    usedChars += c;
    result.push(messages[startIdx]);
    startIdx++;
  }

  // Add messages from the end (most recent) until budget is reached
  const reversed: typeof messages = [];
  for (let i = messages.length - 1; i >= startIdx; i--) {
    const msgChars = typeof messages[i].content === "string" ? messages[i].content.length : 500;
    if (usedChars + msgChars > maxChars) break;
    reversed.push(messages[i]);
    usedChars += msgChars;
  }

  if (reversed.length < messages.length - startIdx) {
    result.push({
      role: "system",
      content: "[Earlier conversation history was trimmed to fit context window]",
    });
  }
  result.push(...reversed.reverse());

  console.log(`[ContextTrim] Trimmed ${messages.length} messages (${totalChars} chars) → ${result.length} messages (${usedChars} chars)`);
  return result;
}

// ─── Feature 2: Smart Tool Result Compression ───

/**
 * Compress tool results intelligently based on tool type.
 * Preserves structure (first/last lines, key fields) instead of raw slice.
 */
function compressToolResult(toolName: string, result: any, maxLen: number): string {
  if (!result) return JSON.stringify(result);

  try {
    // For error results, keep full error info (usually small)
    if (result.ok === false || result.exitCode === 1) {
      const compact: any = { ok: false };
      if (result.error) compact.error = result.error.slice(0, 2000);
      if (result.stderr) compact.stderr = result.stderr.slice(0, 2000);
      if (result.exitCode !== undefined) compact.exitCode = result.exitCode;
      if (result.outputFiles) compact.outputFiles = result.outputFiles;
      return JSON.stringify(compact);
    }

    // run_python / run_shell: keep first+last lines of stdout
    if ((toolName === "run_python" || toolName === "run_shell") && result.stdout) {
      const lines = result.stdout.split("\n");
      const compact: any = { exitCode: result.exitCode ?? 0 };
      if (result.outputFiles?.length) compact.outputFiles = result.outputFiles;
      if (lines.length <= 60) {
        compact.stdout = result.stdout.slice(0, maxLen - 200);
      } else {
        const head = lines.slice(0, 30).join("\n");
        const tail = lines.slice(-20).join("\n");
        compact.stdout = `${head}\n\n[...${lines.length - 50} lines omitted...]\n\n${tail}`;
      }
      if (result.stderr) compact.stderr = result.stderr.slice(0, 1000);
      return JSON.stringify(compact);
    }

    // web_search: keep titles + URLs, truncate snippets
    if (toolName === "web_search" && Array.isArray(result.results)) {
      const compact = {
        ...result,
        results: result.results.map((r: any) => ({
          title: r.title,
          url: r.url,
          snippet: typeof r.snippet === "string" ? r.snippet.slice(0, 150) : r.snippet,
        })),
      };
      return JSON.stringify(compact);
    }

    // fetch_url: keep structure preview
    if (toolName === "fetch_url" && result.content) {
      const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      const lines = content.split("\n");
      const compact: any = { ok: true, url: result.url };
      if (lines.length <= 50) {
        compact.content = content.slice(0, maxLen - 200);
      } else {
        compact.content = lines.slice(0, 30).join("\n") + `\n[...${lines.length - 40} lines omitted...]\n` + lines.slice(-10).join("\n");
      }
      return JSON.stringify(compact);
    }

    // read_file: keep first+last lines
    if (toolName === "read_file" && result.content) {
      const lines = result.content.split("\n");
      const compact: any = { path: result.path };
      if (lines.length <= 50) {
        compact.content = result.content.slice(0, maxLen - 100);
      } else {
        compact.content = lines.slice(0, 30).join("\n") + `\n[...${lines.length - 40} lines omitted...]\n` + lines.slice(-10).join("\n");
      }
      return JSON.stringify(compact);
    }

    // list_files: cap entries
    if (toolName === "list_files" && Array.isArray(result.files)) {
      if (result.files.length > 50) {
        return JSON.stringify({
          ...result,
          files: result.files.slice(0, 50),
          _note: `Showing 50 of ${result.files.length} files`,
        });
      }
    }

    // Default: stringify and truncate with valid JSON
    const raw = JSON.stringify(result);
    if (raw.length <= maxLen) return raw;

    // Try to produce a meaningful summary
    if (typeof result === "object" && result !== null) {
      const compact: any = {};
      for (const [key, val] of Object.entries(result)) {
        if (typeof val === "string" && val.length > 500) {
          compact[key] = val.slice(0, 500) + `...(${val.length} chars total)`;
        } else if (Array.isArray(val) && val.length > 20) {
          compact[key] = val.slice(0, 20);
          compact[`_${key}_note`] = `Showing 20 of ${val.length} items`;
        } else {
          compact[key] = val;
        }
      }
      const compactStr = JSON.stringify(compact);
      if (compactStr.length <= maxLen) return compactStr;
      return compactStr.slice(0, maxLen - 50) + '..."_truncated":true}';
    }

    return raw.slice(0, maxLen - 20) + "...(truncated)";
  } catch {
    return JSON.stringify(result).slice(0, maxLen);
  }
}

// ─── Feature 1: Full Compact Algorithm ───
// Implements a structured 9-step compaction pipeline:
//  1. Pre-compact hooks → 2. Structured summarization prompt (9 sections)
//  3. Strip images/docs → 4. Send to model (forked/fallback)
//  5. Handle prompt-too-long (retry with group dropping)
//  6. Format summary (strip <analysis>, extract <summary>)
//  7. Restore critical context (files, plan, skills, tools)
//  8. Build new message history (boundary + summary + attachments)
//  9. Cleanup (transcript, caches)

// --- Compact state tracking ---
interface CompactMetadata {
  compactionId: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  timestamp: string;
  transcriptPath?: string;
}

// Track recently-read files across the session for post-compact restoration
const _recentFileReads: Map<string, { path: string; content: string; timestamp: number }> = new Map();
const MAX_RECENT_FILES = 10;

export function trackFileRead(filePath: string, content: string): void {
  _recentFileReads.set(filePath, {
    path: filePath,
    content: content.slice(0, 20_000), // keep up to 20K chars per file for restoration
    timestamp: Date.now(),
  });
  // Evict oldest entries beyond limit
  if (_recentFileReads.size > MAX_RECENT_FILES) {
    const oldest = [..._recentFileReads.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, _recentFileReads.size - MAX_RECENT_FILES);
    for (const [key] of oldest) _recentFileReads.delete(key);
  }
}

// Track active plan for post-compact restoration
let _activePlan: string | null = null;
export function setActivePlan(plan: string | null): void { _activePlan = plan; }
export function getActivePlan(): string | null { return _activePlan; }

// Track invoked skills for post-compact restoration
const _invokedSkills: Map<string, string> = new Map();
export function trackInvokedSkill(name: string, content: string): void {
  _invokedSkills.set(name, content.slice(0, 5000));
}

// --- Compact hooks ---
type CompactHook = (messages: ChatMessage[]) => Promise<string | void>;
const _preCompactHooks: CompactHook[] = [];
const _postCompactHooks: CompactHook[] = [];

export function onPreCompact(hook: CompactHook): void { _preCompactHooks.push(hook); }
export function onPostCompact(hook: CompactHook): void { _postCompactHooks.push(hook); }

// Consecutive compact failure tracking (circuit breaker)
let _consecutiveCompactFailures = 0;
const MAX_COMPACT_FAILURES = 3;

// Compaction cooldown: minimum interval between compactions (prevents excessive LLM calls)
let _lastCompactionTime = 0;
const COMPACT_COOLDOWN_MS = 60_000; // 60 seconds minimum between compactions

/**
 * Build the structured summarization prompt with 9 sections.
 * Asks the model to produce <analysis> (scratchpad, stripped later) and <summary>.
 */
function buildSummarizationPrompt(
  toCompress: ChatMessage[],
  toolCallCount: number,
  conversationParts: string[]
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are a conversation context compressor. You will receive a conversation history and must produce a structured summary.

RULES:
- Do NOT use any tools — respond with text only.
- First produce an <analysis> block where you think through what's important (this is your scratchpad and will be stripped).
- Then produce a <summary> block with EXACTLY these 9 sections:

<analysis>
(Your private reasoning about what to preserve and what to drop. Consider: what is the user trying to accomplish? What files were touched? What errors occurred? What decisions were made?)
</analysis>

<summary>
## a. Primary Request and Intent
(What the user originally asked for and what they're trying to achieve)

## b. Key Technical Concepts
(Important technical terms, algorithms, frameworks, or domain concepts discussed)

## c. Files and Code Sections
(File paths mentioned or modified, with relevant code snippets — preserve exact paths and line numbers)

## d. Errors and Fixes
(Errors encountered and how they were resolved, or unresolved errors)

## e. Problem Solving
(Key decisions made, approaches tried, reasoning about trade-offs)

## f. All User Messages
(Reproduce ALL non-tool-result user messages — preserve the user's exact words where possible)

## g. Pending Tasks
(Tasks mentioned but not yet completed, next steps discussed)

## h. Current Work
(What was actively being worked on at the end of this conversation segment)

## i. Optional Next Step
(If the conversation implies a clear next action, state it with verbatim quotes from the user if applicable)
</summary>

Be thorough but concise. Preserve factual details, file paths, exact error messages, and code snippets. Do NOT fabricate information.`
    },
    {
      role: "user",
      content: `Compress this conversation history (${toCompress.length} messages, ${toolCallCount} tool calls):\n\n${conversationParts.join("\n")}`
    }
  ];
}

/**
 * Step 3: Strip unnecessary content from messages before summarization.
 * Images → [image] placeholders, documents → [document] placeholders.
 */
function stripForSummarization(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (Array.isArray(msg.content)) {
      const stripped = msg.content.map((part: any) => {
        if (part.type === "image_url" || part.type === "image") {
          return { type: "text", text: "[image]" };
        }
        if (part.type === "document" || part.type === "file") {
          return { type: "text", text: `[document: ${part.name || part.path || "unknown"}]` };
        }
        return part;
      });
      return { ...msg, content: stripped };
    }
    return msg;
  });
}

/**
 * Step 5: Group messages by API round and drop oldest groups to fit token budget.
 * A "round" = one user message + its assistant response + any tool results.
 */
function groupMessagesByRound(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) groups.push(current);

  return groups;
}

/**
 * Step 6: Format the summary — strip <analysis>, extract <summary>, wrap with session header.
 */
function formatCompactSummary(
  rawSummary: string,
  metadata: CompactMetadata
): string {
  // Strip <analysis> block (chain-of-thought scratchpad)
  let formatted = rawSummary.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();

  // Extract <summary> content if present
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    formatted = summaryMatch[1].trim();
  }

  // Wrap with session continuation header
  const header = `This session is continued from a previous conversation that was compacted to save context space.
Compaction ID: ${metadata.compactionId} | Messages: ${metadata.messagesBefore} → ${metadata.messagesAfter} | Tokens saved: ~${metadata.tokensBefore - metadata.tokensAfter}`;

  const transcriptNote = metadata.transcriptPath
    ? `\nFull pre-compact transcript available at: ${metadata.transcriptPath} (use read_file to access if needed)`
    : "";

  return `${header}${transcriptNote}\n\n---\n\n${formatted}`;
}

/**
 * Step 7: Build post-compact attachments that restore critical context.
 */
function buildPostCompactAttachments(): ChatMessage[] {
  const attachments: ChatMessage[] = [];
  const MAX_FILE_TOKENS = 5000; // ~20K chars per file
  const MAX_TOTAL_FILE_CHARS = 200_000; // 50K token budget for files

  // 1. Top 5 recently-read files
  const recentFiles = [..._recentFileReads.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);

  if (recentFiles.length > 0) {
    let totalChars = 0;
    const fileParts: string[] = [];
    for (const file of recentFiles) {
      const maxChars = MAX_FILE_TOKENS * 4; // ~4 chars per token
      const content = file.content.slice(0, maxChars);
      if (totalChars + content.length > MAX_TOTAL_FILE_CHARS) break;
      fileParts.push(`### ${file.path}\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
    }
    if (fileParts.length > 0) {
      attachments.push({
        role: "system",
        content: `[Post-compact: Recently-read files (${fileParts.length} files)]\n\n${fileParts.join("\n\n")}`,
      });
    }
  }

  // 2. Active plan
  if (_activePlan) {
    attachments.push({
      role: "system",
      content: `[Post-compact: Active Plan]\n\n${_activePlan}`,
    });
  }

  // 3. Invoked skills (up to 5K tokens each)
  if (_invokedSkills.size > 0) {
    const skillParts = [..._invokedSkills.entries()]
      .map(([name, content]) => `### Skill: ${name}\n${content}`)
      .join("\n\n");
    attachments.push({
      role: "system",
      content: `[Post-compact: Invoked Skills]\n\n${skillParts}`,
    });
  }

  return attachments;
}

/**
 * Step 9: Write pre-compact transcript to disk for later retrieval.
 */
async function writeCompactTranscript(
  compactionId: string,
  messages: ChatMessage[]
): Promise<string | undefined> {
  try {
    const transcriptDir = path.resolve("data", "transcripts");
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, `compact_${compactionId}.jsonl`);

    const lines = messages.map(msg => JSON.stringify({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content.slice(0, 10_000) : "[multimodal]",
      tool_calls: msg.tool_calls?.map(tc => ({ name: tc.function?.name, id: tc.id })),
      tool_call_id: msg.tool_call_id,
    }));

    await fs.writeFile(transcriptPath, lines.join("\n"));
    console.log(`[Compact] Transcript written: ${transcriptPath} (${lines.length} messages)`);
    return transcriptPath;
  } catch (err: any) {
    console.error(`[Compact] Failed to write transcript: ${err.message}`);
    return undefined;
  }
}

/**
 * Full Compact Algorithm — structured 9-step compaction pipeline.
 *
 * Replaces older messages with a structured LLM-generated summary,
 * restores critical context (files, plans, skills), and writes
 * a transcript of the pre-compact messages for later retrieval.
 */
export async function compressOlderMessages(
  allMessages: ChatMessage[],
  windowSize: number = 10,
  model?: string
): Promise<ChatMessage[]> {
  // Find boundaries: system messages at start, then the rest
  let systemEnd = 0;
  while (systemEnd < allMessages.length && allMessages[systemEnd].role === "system") {
    systemEnd++;
  }

  const nonSystemMessages = allMessages.slice(systemEnd);
  if (nonSystemMessages.length <= windowSize) {
    return allMessages; // Nothing to compress
  }

  // Circuit breaker: skip if too many consecutive failures
  if (_consecutiveCompactFailures >= MAX_COMPACT_FAILURES) {
    console.log(`[Compact] Circuit breaker: ${_consecutiveCompactFailures} consecutive failures. Skipping compaction.`);
    return allMessages;
  }

  // Cooldown: skip if compacted too recently (prevents excessive LLM summarization calls)
  const now = Date.now();
  if (now - _lastCompactionTime < COMPACT_COOLDOWN_MS) {
    console.log(`[Compact] Cooldown: last compaction was ${Math.round((now - _lastCompactionTime) / 1000)}s ago (min ${COMPACT_COOLDOWN_MS / 1000}s). Skipping.`);
    return allMessages;
  }

  const compactionId = crypto.randomBytes(8).toString("hex");
  const tokensBefore = Math.ceil(estimateMessagesChars(allMessages) / 4);

  console.log(`[Compact] Starting compaction ${compactionId} — ${allMessages.length} messages, ~${tokensBefore} tokens`);

  // ─── Step 1: Pre-compact hooks ───
  const hookInjections: string[] = [];
  for (const hook of _preCompactHooks) {
    try {
      const result = await hook(allMessages);
      if (result) hookInjections.push(result);
    } catch (err: any) {
      console.error(`[Compact] Pre-compact hook failed: ${err.message}`);
    }
  }

  // ─── Step 2 & 3: Prepare messages for summarization ───
  const toCompress = nonSystemMessages.slice(0, nonSystemMessages.length - windowSize);
  const toKeep = nonSystemMessages.slice(nonSystemMessages.length - windowSize);

  // Step 3: Strip images/documents from messages before summarization
  const strippedMessages = stripForSummarization(toCompress);

  // Build conversation parts for the summarization prompt
  const summaryParts: string[] = [];
  let toolCallCount = 0;
  for (const msg of strippedMessages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((p: any) => p.text || p.type || "").join(" ")
          : "(multimodal)";
      summaryParts.push(`USER: ${text.slice(0, 500)}`);
    } else if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text) summaryParts.push(`ASSISTANT: ${text.slice(0, 300)}`);
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments || "";
          const argsPreview = typeof args === "string" ? args.slice(0, 100) : JSON.stringify(args).slice(0, 100);
          summaryParts.push(`  → Called ${tc.function?.name || "unknown"}(${argsPreview})`);
          toolCallCount++;
        }
      }
    } else if (msg.role === "tool") {
      const text = typeof msg.content === "string" ? msg.content : "";
      summaryParts.push(`  RESULT: ${text.slice(0, 200)}`);
    }
  }

  // Add hook injections to the prompt
  if (hookInjections.length > 0) {
    summaryParts.push("\n--- Pre-compact hook context ---");
    summaryParts.push(...hookInjections);
  }

  // ─── Step 4 & 5: Send to model with prompt-too-long retry logic ───
  let summary = "";
  let promptMessages = summaryParts;
  const MAX_PROMPT_RETRIES = 3;

  for (let retry = 0; retry < MAX_PROMPT_RETRIES; retry++) {
    const compressionPrompt = buildSummarizationPrompt(
      toCompress, toolCallCount, promptMessages
    );

    try {
      console.log(`[Compact] Sending summarization request (attempt ${retry + 1}/${MAX_PROMPT_RETRIES}, ${promptMessages.join("\n").length} chars)...`);
      const data = await llmCall(compressionPrompt, { model });
      summary = data.choices?.[0]?.message?.content || "";

      if (summary) {
        _consecutiveCompactFailures = 0; // Reset circuit breaker on success
        break;
      }

      console.log("[Compact] LLM returned empty summary.");
    } catch (err: any) {
      const errMsg = err.message || "";
      const isPromptTooLong = errMsg.includes("context window exceeds") ||
        errMsg.includes("context_length_exceeded") ||
        errMsg.includes("maximum context length") ||
        errMsg.includes("too many tokens");

      if (isPromptTooLong && retry < MAX_PROMPT_RETRIES - 1) {
        // Step 5: Drop oldest message groups to free tokens
        console.log(`[Compact] Prompt too long — dropping oldest message groups (retry ${retry + 1})...`);
        const groups = groupMessagesByRound(
          strippedMessages.slice(0, strippedMessages.length - Math.floor(strippedMessages.length / (retry + 2)))
        );

        // Rebuild summary parts from remaining groups
        const remaining = groups.flat();
        promptMessages = [];
        for (const msg of remaining) {
          if (msg.role === "user") {
            const text = typeof msg.content === "string" ? msg.content : "(multimodal)";
            promptMessages.push(`USER: ${text.slice(0, 300)}`);
          } else if (msg.role === "assistant") {
            const text = typeof msg.content === "string" ? msg.content : "";
            if (text) promptMessages.push(`ASSISTANT: ${text.slice(0, 150)}`);
            if (msg.tool_calls?.length) {
              for (const tc of msg.tool_calls) {
                promptMessages.push(`  → Called ${tc.function?.name || "unknown"}`);
              }
            }
          } else if (msg.role === "tool") {
            const text = typeof msg.content === "string" ? msg.content : "";
            promptMessages.push(`  RESULT: ${text.slice(0, 100)}`);
          }
        }
        console.log(`[Compact] Reduced to ${promptMessages.length} parts (dropped ${summaryParts.length - promptMessages.length} parts)`);
        continue;
      }

      console.error(`[Compact] Summarization failed: ${err.message}`);
      _consecutiveCompactFailures++;
      return allMessages; // Fallback: return uncompacted
    }
  }

  if (!summary) {
    console.log("[Compact] All summarization attempts returned empty. Falling back to naive trim.");
    _consecutiveCompactFailures++;
    return allMessages;
  }

  // ─── Step 6: Format the summary ───
  // Write transcript BEFORE formatting so we have the path
  const transcriptPath = await writeCompactTranscript(compactionId, toCompress);

  const metadata: CompactMetadata = {
    compactionId,
    tokensBefore,
    tokensAfter: 0, // computed after building final messages
    messagesBefore: allMessages.length,
    messagesAfter: 0,
    timestamp: new Date().toISOString(),
    transcriptPath,
  };

  const formattedSummary = formatCompactSummary(summary, metadata);

  // ─── Step 7: Restore critical context ───
  const postCompactAttachments = buildPostCompactAttachments();

  // ─── Step 8: Build the new message history ───
  const compressed: ChatMessage[] = [
    // Keep original system messages
    ...allMessages.slice(0, systemEnd),
    // Compact boundary marker
    {
      role: "system",
      content: `[COMPACT BOUNDARY — id:${compactionId} | ${toCompress.length} messages compacted, ${toolCallCount} tool calls | tokens saved: ~${tokensBefore}]`,
    },
    // The structured summary
    {
      role: "system",
      content: formattedSummary,
    },
    // Post-compact attachments (recently-read files, plan, skills)
    ...postCompactAttachments,
  ];

  // Ensure a user message exists before assistant messages — some APIs reject system→assistant
  if (toKeep.length === 0 || toKeep[0].role !== "user") {
    const firstUserMsg = toCompress.find((m) => m.role === "user");
    compressed.push({
      role: "user",
      content: firstUserMsg
        ? (typeof firstUserMsg.content === "string" ? firstUserMsg.content : "Continue with the task.")
        : "Continue with the task.",
    });
  }

  // Keep recent messages
  compressed.push(...toKeep);

  // Update metadata with final token count
  metadata.tokensAfter = Math.ceil(estimateMessagesChars(compressed) / 4);
  metadata.messagesAfter = compressed.length;

  console.log(`[Compact] Compaction ${compactionId} complete: ${metadata.messagesBefore} → ${metadata.messagesAfter} messages, ~${metadata.tokensBefore} → ~${metadata.tokensAfter} tokens`);
  _lastCompactionTime = Date.now();

  // ─── Step 9: Cleanup ───
  // Clear file-read cache (will be rebuilt as conversation continues)
  _recentFileReads.clear();

  // Execute post-compact hooks
  for (const hook of _postCompactHooks) {
    try {
      await hook(compressed);
    } catch (err: any) {
      console.error(`[Compact] Post-compact hook failed: ${err.message}`);
    }
  }

  return compressed;
}

// ─── Feature 3: Checkpoint & Resume ───

interface ToolLoopCheckpoint {
  sessionId: string;
  checkpointRound: number;
  timestamp: string;
  allMessages: ChatMessage[];
  toolResults: Array<{ tool: string; result: any }>;
  toolCallHistory: string[];
  totalToolCalls: number;
  consecutiveErrors: number;
  earlyContent: string | null;
  systemPrompt?: string;
}

async function saveCheckpoint(sessionId: string, checkpoint: ToolLoopCheckpoint): Promise<void> {
  const dir = await getCheckpointDir();
  const fp = `${dir}/${sessionId}.json`;
  // Compress tool results in checkpoint to keep file size reasonable
  const compactCheckpoint = {
    ...checkpoint,
    toolResults: checkpoint.toolResults.map(tr => ({
      tool: tr.tool,
      result: {
        ok: tr.result?.ok,
        exitCode: tr.result?.exitCode,
        outputFiles: tr.result?.outputFiles,
        stdout: tr.result?.stdout?.slice(0, 2000),
        stderr: tr.result?.stderr?.slice(0, 1000),
        error: tr.result?.error,
      }
    })),
    // Compress allMessages — only keep last 20 messages fully, summarize earlier ones
    allMessages: checkpoint.allMessages.length > 30
      ? [
          ...checkpoint.allMessages.slice(0, 2), // system prompt(s)
          { role: "system" as const, content: `[Checkpoint: ${checkpoint.allMessages.length - 22} earlier messages omitted]` },
          ...checkpoint.allMessages.slice(-20),
        ]
      : checkpoint.allMessages,
  };
  await fs.writeFile(fp, JSON.stringify(compactCheckpoint));
  console.log(`[Checkpoint] Saved round ${checkpoint.checkpointRound} for session ${sessionId} (${(JSON.stringify(compactCheckpoint).length / 1024).toFixed(0)}KB)`);
}

async function loadCheckpoint(sessionId: string): Promise<ToolLoopCheckpoint | null> {
  const dir = await getCheckpointDir();
  const fp = `${dir}/${sessionId}.json`;
  try {
    const content = await fs.readFile(fp, "utf-8");
    const checkpoint = JSON.parse(content);
    console.log(`[Checkpoint] Loaded checkpoint for session ${sessionId} at round ${checkpoint.checkpointRound}`);
    return checkpoint;
  } catch {
    return null;
  }
}

async function clearCheckpoint(sessionId: string): Promise<void> {
  const dir = await getCheckpointDir();
  const fp = `${dir}/${sessionId}.json`;
  try {
    await fs.unlink(fp);
    console.log(`[Checkpoint] Cleared checkpoint for session ${sessionId}`);
  } catch {} // Ignore if doesn't exist
}

interface TigerBotResponse {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  toolResults?: Array<{ tool: string; result: any }>;
}

// Strip internal tool call markers from LLM responses before showing to users
// Handles various formats the LLM may use to represent tool calls inline
function sanitizeToolCallContent(content: string): string {
  if (!content) return content;
  let cleaned = content;
  // Remove [tool_name]({"param": "value", ...}) style markers (JSON args)
  cleaned = cleaned.replace(/\[(\w+)\]\s*\(\s*\{[^}]*\}\s*\)/g, "");
  // Remove [tool_name](<parameter name="...">...</parameter>) style markers (XML-like, single line)
  cleaned = cleaned.replace(/\[(\w+)\]\s*\(<parameter[^)]*\)/g, "");
  // Remove multi-line XML parameter blocks: [tool_name](<parameter name="key">value</parameter>)
  // Also handles malformed variants like <fetch_url](<parameter...
  cleaned = cleaned.replace(/\[?\w+\]?\s*\(<parameter\s+name="[^"]*">[^<]*<\/parameter>\s*\)/g, "");
  // Remove standalone [tool_name] markers for known internal tools
  cleaned = cleaned.replace(/\[(web_search|fetch_url|run_python|run_react|read_file|write_file|list_files|web_fetch|load_skill)\]/g, "");
  // Remove lines that are just tool call artifacts (e.g., bare parameter tags)
  cleaned = cleaned.replace(/^.*<parameter\s+name="[^"]*">.*<\/parameter>.*$/gm, "");
  // Clean up excessive blank lines left after removal
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

async function getApiConfig() {
  const settings = await getSettings();
  const provider = settings.aiProvider || "openrouter";
  const apiKey = settings.tigerBotApiKey;
  const model = settings.tigerBotModel || "TigerBot-70B-Chat";
  const rawUrl = settings.tigerBotApiUrl || "https://api.tigerbot.com/bot-chat/openai/v1/chat/completions";
  // Anthropic uses /v1/messages endpoint, not /chat/completions
  const isAnthropic = provider === "anthropic_claude_code" || rawUrl.includes("api.anthropic.com");
  const apiUrl = isAnthropic
    ? rawUrl.replace(/\/$/, "").replace(/\/messages$/, "") + "/messages"
    : rawUrl.endsWith("/chat/completions") ? rawUrl : rawUrl.replace(/\/$/, "") + "/chat/completions";
  // OAuth tokens (sk-ant-oat01-) use Bearer auth; API keys (sk-ant-api) use x-api-key
  const isOAuthToken = isAnthropic && apiKey?.startsWith("sk-ant-oat01-");
  return { apiKey, model, apiUrl, isAnthropic, isOAuthToken };
}

// Single LLM call (no tool loop)
/**
 * Sanitize messages before sending to LLM API.
 * Ensures tool call / tool result messages are properly paired —
 * some APIs (e.g. zAi/GLM) reject orphaned tool messages.
 */
function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  // Collect all valid tool_call IDs from assistant messages
  const validToolCallIds = new Set<string>();
  for (const msg of messages) {
    if ((msg as any).tool_calls) {
      for (const tc of (msg as any).tool_calls) {
        if (tc.id) validToolCallIds.add(tc.id);
      }
    }
  }

  // Collect all tool result IDs
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && (msg as any).tool_call_id) {
      toolResultIds.add((msg as any).tool_call_id);
    }
  }

  const filtered = messages.filter((msg) => {
    // Remove tool results that reference non-existent tool calls
    if (msg.role === "tool" && (msg as any).tool_call_id) {
      return validToolCallIds.has((msg as any).tool_call_id);
    }
    // Remove assistant messages with tool_calls that have no matching tool results
    // (only if ALL their tool_call IDs are orphaned — partial is ok)
    if (msg.role === "assistant" && (msg as any).tool_calls?.length) {
      const tcIds = (msg as any).tool_calls.map((tc: any) => tc.id).filter(Boolean);
      const hasAnyResult = tcIds.some((id: string) => toolResultIds.has(id));
      if (tcIds.length > 0 && !hasAnyResult) {
        // Convert to plain assistant message — keep content, drop tool_calls
        delete (msg as any).tool_calls;
        if (!msg.content) msg.content = "";
      }
      // Ensure every tool_call has type: "function" — some APIs omit it in responses
      // but reject it if missing when sent back
      if ((msg as any).tool_calls) {
        for (const tc of (msg as any).tool_calls) {
          if (!tc.type) tc.type = "function";
        }
      }
    }
    // Ensure content is never null
    if (msg.content === null || msg.content === undefined) {
      msg.content = "";
    }
    return true;
  });

  // Merge consecutive system messages into one — some APIs (MiniMax) only allow a single system message
  const merged: ChatMessage[] = [];
  for (const msg of filtered) {
    const last = merged[merged.length - 1];
    if (msg.role === "system" && last?.role === "system") {
      last.content = (last.content || "") + "\n\n" + (msg.content || "");
    } else {
      merged.push(msg);
    }
  }

  // Convert mid-conversation system messages to user messages.
  // Many APIs (MiniMax, DeepSeek, etc.) only allow role=system at position 0.
  // Keep the first system message as-is; convert all others to user role.
  let seenFirstSystem = false;
  for (const msg of merged) {
    if (msg.role === "system") {
      if (seenFirstSystem) {
        msg.role = "user";
        msg.content = `[System Instructions]\n${msg.content || ""}`;
      }
      seenFirstSystem = true;
    }
  }

  // Merge consecutive user messages — some APIs reject user→user sequences
  const deduped: ChatMessage[] = [];
  for (const msg of merged) {
    const last = deduped[deduped.length - 1];
    if (msg.role === "user" && last?.role === "user" && typeof msg.content === "string" && typeof last.content === "string") {
      last.content = last.content + "\n\n" + msg.content;
    } else {
      deduped.push(msg);
    }
  }

  // Ensure a user message exists before the first assistant message
  // Some APIs (zAi/GLM) reject system→assistant without a user message in between
  let firstNonSystem = deduped.findIndex((m) => m.role !== "system");
  if (firstNonSystem >= 0 && deduped[firstNonSystem].role !== "user") {
    deduped.splice(firstNonSystem, 0, { role: "user", content: "Continue with the task." });
  }

  return deduped;
}

// Convert OpenAI-format messages to Anthropic format
function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: any[] } {
  let system = "";
  const msgs: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let input: any = {};
          try { input = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch { input = { raw: tc.function.arguments }; }
          content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
      }
      msgs.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
      continue;
    }
    if (m.role === "tool") {
      // Anthropic uses tool_result blocks inside a user message
      const last = msgs[msgs.length - 1];
      const resultBlock = { type: "tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
      if (last?.role === "user") {
        last.content = Array.isArray(last.content) ? [...last.content, resultBlock] : [resultBlock];
      } else {
        msgs.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }
    // user message
    if (typeof m.content === "string") {
      msgs.push({ role: "user", content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = m.content.map((p: any) => {
        if (p.type === "image_url") {
          const url = p.image_url?.url || "";
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(image\/\w+);base64,(.+)/);
            if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
          }
          return { type: "text", text: `[Image: ${url}]` };
        }
        return { type: "text", text: p.text || "" };
      });
      msgs.push({ role: "user", content: parts });
    } else {
      msgs.push({ role: "user", content: String(m.content) });
    }
  }
  // Anthropic requires alternating user/assistant; merge consecutive same-role
  const merged: any[] = [];
  for (const msg of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
      const newContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      last.content = [...lastContent, ...newContent];
    } else {
      merged.push(msg);
    }
  }
  return { system, messages: merged };
}

// Convert OpenAI tool definitions to Anthropic format
function toAnthropicTools(tools: any[]): any[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

// Convert Anthropic response to OpenAI-compatible format
function fromAnthropicResponse(data: any): any {
  const content = data.content || [];
  const textParts = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const toolUses = content.filter((b: any) => b.type === "tool_use");
  const toolCalls = toolUses.map((tu: any) => ({
    id: tu.id,
    type: "function",
    function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
  }));
  const finishReason = data.stop_reason === "tool_use" ? "tool_calls" : data.stop_reason === "end_turn" ? "stop" : data.stop_reason || "stop";
  return {
    choices: [{
      index: 0,
      message: { role: "assistant", content: textParts, tool_calls: toolCalls.length ? toolCalls : undefined },
      finish_reason: finishReason,
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    } : undefined,
  };
}

async function llmCall(messages: ChatMessage[], options: { tools?: any[]; model?: string; signal?: AbortSignal } = {}): Promise<any> {
  const { apiKey, model, apiUrl, isAnthropic, isOAuthToken } = await getApiConfig();
  if (!apiKey) throw new Error("API key not configured");

  const sanitized = sanitizeMessages(messages);
  const settings = await getSettings();

  let response: Response;
  let body: any;

  // Determine max_tokens: use setting if provided, else provider-appropriate default
  const maxTokens = settings.agentMaxTokens
    ?? (apiUrl.includes("minimax.io") ? 16384 : 81920);

  if (isAnthropic) {
    // Anthropic Messages API format
    const { system, messages: anthropicMsgs } = toAnthropicMessages(sanitized);
    body = {
      model: options.model || model,
      messages: anthropicMsgs,
      system: system || undefined,
      temperature: settings.agentTemperature ?? 0.7,
      max_tokens: maxTokens,
    };
    if (options.tools?.length) {
      body.tools = toAnthropicTools(options.tools);
      body.tool_choice = { type: "auto" };
    }
    // OAuth tokens use Bearer auth; API keys use x-api-key
    const authHeaders: Record<string, string> = isOAuthToken
      ? { Authorization: `Bearer ${apiKey}` }
      : { "x-api-key": apiKey };
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } else {
    // OpenAI-compatible format
    body = {
      model: options.model || model,
      messages: sanitized,
      temperature: settings.agentTemperature ?? 0.7,
      max_tokens: maxTokens,
    };
    if (options.tools && options.tools.length) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  if (!response.ok) {
    const error = await response.text();
    const bodyStr = JSON.stringify(body);
    const bodySize = bodyStr.length;
    console.error(`[llmCall] API Error ${response.status}. Request body size: ${(bodySize / 1024 / 1024).toFixed(2)}MB, messages: ${sanitized.length}`);
    // Dump message roles/structure for debugging
    const msgDump = sanitized.map((m: any, i: number) => {
      const tc = m.tool_calls ? ` tool_calls:[${m.tool_calls.map((t: any) => t.id).join(",")}]` : "";
      const tid = m.tool_call_id ? ` tool_call_id:${m.tool_call_id}` : "";
      const contentType = m.content === null ? "null" : m.content === undefined ? "undefined" : typeof m.content === "string" ? `str(${m.content.length})` : `array(${m.content.length})`;
      return `  [${i}] role=${m.role} content=${contentType}${tc}${tid}`;
    }).join("\n");
    console.error(`[llmCall] Messages structure:\n${msgDump}`);
    // Write full request body to debug file for inspection
    try {
      const fs = await import("fs/promises");
      await fs.writeFile("/root/cowork/data/debug_last_request.json", bodyStr);
      console.error(`[llmCall] Full request body written to /root/cowork/data/debug_last_request.json`);
    } catch {}
    throw new Error(`API Error (${response.status}): ${error.slice(0, 500)}`);
  }

  let json: any;
  const responseText = await response.text();
  try {
    json = JSON.parse(responseText);
  } catch (parseErr: any) {
    const bodySize = JSON.stringify(body).length;
    console.error(`[llmCall] JSON parse failed. Response (first 1000): ${responseText.slice(0, 1000)}`);
    console.error(`[llmCall] Request body size: ${(bodySize / 1024 / 1024).toFixed(2)}MB, messages: ${messages.length}`);
    throw new Error(`API returned invalid JSON (body size: ${(bodySize / 1024 / 1024).toFixed(1)}MB): ${parseErr.message}`);
  }

  // Convert Anthropic response to OpenAI-compatible format
  if (isAnthropic && json.content && !json.choices) {
    json = fromAnthropicResponse(json);
  }

  if (!json.choices?.length) {
    console.error(`[llmCall] API returned no choices. Response:`, JSON.stringify(json).slice(0, 2000));
    const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
    if (hasImages) console.error(`[llmCall] Request included images. Model may not support vision or format is wrong.`);
  }
  return json;
}

// Tool-calling loop (like Tiger_bot's runWithTools)
export async function callTigerBotWithTools(
  messages: ChatMessage[],
  systemPrompt?: string,
  onToolCall?: (name: string, args: any) => void,
  onToolResult?: (name: string, result: any) => void,
  signal?: AbortSignal,
  toolsOverride?: any[],
  modelOverride?: string,
  sessionId?: string,
  onRetry?: (attempt: number, maxRetries: number, error: string) => void,
  taskId?: string,
): Promise<TigerBotResponse> {
  // --- Local CLI agent shortcut: delegate entirely to Claude Code or Codex CLI ---
  if (isLocalCliAgent(modelOverride)) {
    const isCodex = isCodexModel(modelOverride);
    const cliName = isCodex ? "Codex" : "Claude Code";
    const runAgent = isCodex ? runCodexAgent : runClaudeCodeAgent;
    console.log(`[ToolLoop] Delegating to ${cliName} CLI (model: ${modelOverride})`);
    const settings = await getSettings();
    const userMsg = [...messages].reverse().find(m => m.role === "user");
    const task = typeof userMsg?.content === "string" ? userMsg.content : "(no task)";
    const subModel = extractCliSubModel(modelOverride);
    const result = await runAgent(task, {
      workingDir: settings.sandboxDir || process.cwd(),
      systemPrompt,
      signal,
      timeout: (settings.subAgentTimeout || 120) * 1000,
      ...(isCodex ? {} : { maxTurns: settings.agentMaxToolRounds || 15 }),
      onToolCall: onToolCall || undefined,
      model: subModel,
    });
    return { content: result.content, toolResults: result.toolCalls?.map(t => ({ tool: t, result: { ok: true } })) };
  }

  const { apiKey } = await getApiConfig();
  if (!apiKey) {
    return { content: "API key not configured. Go to Settings to add your API key." };
  }

  const settings = await getSettings();
  const maxToolRounds = settings.agentMaxToolRounds || 15;
  const maxToolCalls = settings.agentMaxToolCalls || 25;
  const compressionInterval = settings.agentCompressionInterval || 5;
  const compressionWindowSize = settings.agentCompressionWindowSize || 10;
  const checkpointInterval = settings.agentCheckpointInterval || 5;
  const checkpointEnabled = settings.agentCheckpointEnabled !== false; // default true
  const maxContextTokens = settings.agentMaxContextTokens || 100_000; // trigger compaction when context exceeds this token estimate

  // Try to resume from checkpoint
  let allMessages: ChatMessage[] = [];
  let toolResults: Array<{ tool: string; result: any }> = [];
  let toolCallHistory: string[] = [];
  let totalToolCalls = 0;
  let consecutiveErrors = 0;
  let startRound = 0;
  let earlyContent: string | null = null;

  if (sessionId && checkpointEnabled) {
    const checkpoint = await loadCheckpoint(sessionId);
    if (checkpoint) {
      console.log(`[ToolLoop] Resuming from checkpoint at round ${checkpoint.checkpointRound}`);
      allMessages = checkpoint.allMessages;
      toolResults = checkpoint.toolResults;
      toolCallHistory = checkpoint.toolCallHistory;
      totalToolCalls = checkpoint.totalToolCalls;
      consecutiveErrors = checkpoint.consecutiveErrors;
      earlyContent = checkpoint.earlyContent;
      startRound = checkpoint.checkpointRound;
    }
  }

  // Initialize messages if not resuming from checkpoint
  if (allMessages.length === 0) {
    if (systemPrompt) {
      allMessages.push({ role: "system", content: systemPrompt });
    }
    allMessages.push(...messages);
  }

  let usesSkill = false;
  let lastUsage: any = undefined;
  let errorRecoveryAttempts = 0;
  const maxErrorRecoveries = settings.agentMaxErrorRecoveries ?? 5; // allow up to 5 self-recovery attempts for resilience
  let noChoicesRetries = 0; // track retries for API returning no choices

  if (modelOverride) {
    console.log(`[ToolLoop] Using model override: ${modelOverride}`);
  }

  for (let round = startRound; round < maxToolRounds; round++) {
    if (signal?.aborted) {
      // Save checkpoint on abort so we can resume later
      if (sessionId && checkpointEnabled) {
        await saveCheckpoint(sessionId, {
          sessionId, checkpointRound: round, timestamp: new Date().toISOString(),
          allMessages, toolResults, toolCallHistory, totalToolCalls, consecutiveErrors, earlyContent, systemPrompt,
        });
      }
      return { content: earlyContent || "Task was cancelled.", toolResults };
    }

    // Feature 1: Compress older messages periodically (every N rounds)
    if (round > 0 && round % compressionInterval === 0) {
      const compressed = await compressOlderMessages(allMessages, compressionWindowSize, settings.agentCompressionModel);
      if (compressed.length < allMessages.length) {
        allMessages.length = 0;
        allMessages.push(...(compressed as ChatMessage[]));
      }
    }

    // Proactive compaction: estimate tokens (~4 chars/token) and compress if over budget
    const estimatedTokens = Math.ceil(estimateMessagesChars(allMessages) / 4);
    if (estimatedTokens > maxContextTokens) {
      console.log(`[ToolLoop] Context ~${estimatedTokens} tokens exceeds limit ${maxContextTokens} — compacting...`);
      const compressed = await compressOlderMessages(allMessages, Math.min(compressionWindowSize, 6), settings.agentCompressionModel);
      if (compressed.length < allMessages.length) {
        allMessages.length = 0;
        allMessages.push(...(compressed as ChatMessage[]));
        console.log(`[ToolLoop] Compacted to ~${Math.ceil(estimateMessagesChars(allMessages) / 4)} tokens (${allMessages.length} messages)`);
      }
    }

    // Safety fallback: naive trim if still over budget after compression
    const trimmed = trimConversationContext(allMessages) as ChatMessage[];
    if (trimmed.length < allMessages.length) {
      allMessages.length = 0;
      allMessages.push(...trimmed);
    }

    // Feature 3: Save checkpoint periodically
    if (sessionId && checkpointEnabled && round > 0 && round % checkpointInterval === 0) {
      await saveCheckpoint(sessionId, {
        sessionId, checkpointRound: round, timestamp: new Date().toISOString(),
        allMessages, toolResults, toolCallHistory, totalToolCalls, consecutiveErrors, earlyContent, systemPrompt,
      });
    }

    let data: any;
    const llmMaxRetries = 3;
    // 529 (overloaded) gets extra retries with exponential backoff to avoid
    // all sub-agents hammering the API simultaneously and all failing fast
    const overloadMaxRetries = 4;
    let overloadRetryCount = 0;
    for (let llmRetry = 0; llmRetry < llmMaxRetries; llmRetry++) {
      try {
        data = await llmCall(allMessages, { tools: toolsOverride || await getTools(), signal, model: modelOverride });
        break; // success
      } catch (err: any) {
        if (err.name === "AbortError") {
          return { content: earlyContent || "Task was cancelled.", toolResults };
        }
        // Detect context overflow errors and compress before retrying
        const errMsg = err.message || "";
        const isContextOverflow = errMsg.includes("context window exceeds") ||
          errMsg.includes("context_length_exceeded") ||
          errMsg.includes("maximum context length") ||
          errMsg.includes("too many tokens") ||
          (errMsg.includes("invalid params") && errMsg.includes("2013"));
        if (isContextOverflow && allMessages.length > 3) {
          console.log(`[ToolLoop] Context overflow detected — compressing before retry (attempt ${llmRetry + 1}/${llmMaxRetries})...`);
          // First try LLM-based compression
          const compressed = await compressOlderMessages(allMessages, Math.min(compressionWindowSize, 6), settings.agentCompressionModel);
          if (compressed.length < allMessages.length) {
            allMessages.length = 0;
            allMessages.push(...(compressed as ChatMessage[]));
            console.log(`[ToolLoop] Compressed to ${allMessages.length} messages. Retrying...`);
          } else {
            // Fallback: aggressive naive trim (halve the char budget)
            const currentChars = estimateMessagesChars(allMessages);
            const trimmed = trimConversationContext(allMessages, Math.floor(currentChars * 0.5)) as ChatMessage[];
            allMessages.length = 0;
            allMessages.push(...trimmed);
            console.log(`[ToolLoop] Trimmed to ${allMessages.length} messages (${estimateMessagesChars(allMessages)} chars). Retrying...`);
          }
          if (llmRetry >= llmMaxRetries - 1) {
            console.error(`[ToolLoop] Context overflow persists after ${llmMaxRetries} compression attempts.`);
            return { content: `Context overflow after ${llmMaxRetries} compression retries: ${errMsg.slice(0, 200)}`, toolResults };
          }
          continue; // retry immediately after compression
        }

        // Detect 529 overloaded — use longer exponential backoff and more retries
        const isOverloaded = errMsg.includes("529") || errMsg.includes("overloaded") || errMsg.includes("Too many requests");
        if (isOverloaded && overloadRetryCount < overloadMaxRetries) {
          overloadRetryCount++;
          // Exponential backoff with jitter: 3s, 6s, 12s, 24s capped at 30s
          const baseDelay = Math.min(3000 * Math.pow(2, overloadRetryCount - 1), 30000);
          const jitter = Math.floor(Math.random() * 2000);
          const delay = baseDelay + jitter;
          console.log(`[ToolLoop] API overloaded (529) — backoff retry ${overloadRetryCount}/${overloadMaxRetries} in ${delay}ms...`);
          onRetry?.(overloadRetryCount, overloadMaxRetries, `API overloaded (529), backing off ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          // Don't increment llmRetry — overload retries are separate from normal retries
          llmRetry--;
          continue;
        }

        if (llmRetry < llmMaxRetries - 1) {
          const delay = (llmRetry + 1) * 2000; // 2s, 4s backoff
          console.log(`[ToolLoop] LLM call failed (attempt ${llmRetry + 1}/${llmMaxRetries}): ${err.message}. Retrying in ${delay}ms...`);
          onRetry?.(llmRetry + 1, llmMaxRetries, err.message);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`[ToolLoop] LLM call failed after ${llmMaxRetries} attempts: ${err.message}`);
          return { content: `Connection error after ${llmMaxRetries} retries: ${err.message}`, toolResults };
        }
      }
    }

    const choice = data.choices?.[0];
    if (!choice) {
      const apiError = data.error?.message || JSON.stringify(data).slice(0, 500);
      console.log(`[ToolLoop] No response from API at round ${round}. Error: ${apiError}`);

      // If API returned a tool_id error, try fixing the messages and retry
      if (apiError.includes("tool_id") || apiError.includes("tool result")) {
        console.log(`[ToolLoop] Tool ID mismatch — removing orphaned tool results and retrying...`);
        // Remove orphaned tool result messages that reference non-existent tool calls
        const validToolCallIds = new Set<string>();
        for (const msg of allMessages) {
          if ((msg as any).tool_calls) {
            for (const tc of (msg as any).tool_calls) {
              validToolCallIds.add(tc.id);
            }
          }
        }
        const beforeLen = allMessages.length;
        const filtered = allMessages.filter((msg) => {
          if (msg.role === "tool" && (msg as any).tool_call_id) {
            return validToolCallIds.has((msg as any).tool_call_id);
          }
          return true;
        });
        if (filtered.length < beforeLen) {
          allMessages.length = 0;
          allMessages.push(...(filtered as ChatMessage[]));
          console.log(`[ToolLoop] Removed ${beforeLen - filtered.length} orphaned tool results. Retrying...`);
          continue; // retry this round
        }
      }

      // If content is empty error, try trimming and retrying
      if (apiError.includes("content is empty") && allMessages.length > 2) {
        console.log(`[ToolLoop] Empty content error — trimming context and retrying...`);
        const trimmed = trimConversationContext(allMessages) as ChatMessage[];
        allMessages.length = 0;
        allMessages.push(...trimmed);
        continue; // retry this round
      }

      // Context overflow or invalid function arguments (often due to oversized context) — compress and retry
      const isCtxOverflow = apiError.includes("context window exceeds") ||
        apiError.includes("context_length_exceeded") ||
        apiError.includes("maximum context length") ||
        apiError.includes("invalid function arguments json string") ||
        (apiError.includes("2013") && (apiError.includes("invalid params") || apiError.includes("exceeds")));
      if (isCtxOverflow && allMessages.length > 3) {
        console.log(`[ToolLoop] Context/args overflow in API response — compressing and retrying...`);
        const compressed = await compressOlderMessages(allMessages, Math.min(compressionWindowSize, 6), settings.agentCompressionModel);
        if (compressed.length < allMessages.length) {
          allMessages.length = 0;
          allMessages.push(...(compressed as ChatMessage[]));
        } else {
          const currentChars = estimateMessagesChars(allMessages);
          const trimmed = trimConversationContext(allMessages, Math.floor(currentChars * 0.5)) as ChatMessage[];
          allMessages.length = 0;
          allMessages.push(...trimmed);
        }
        continue; // retry this round
      }

      noChoicesRetries++;
      if (noChoicesRetries < 3) {
        console.log(`[ToolLoop] Retrying after no-choices error (${noChoicesRetries}/3)...`);
        await new Promise(r => setTimeout(r, 2000));
        continue; // retry this round
      }

      // Give up after 3 retries — return what we have
      console.error(`[ToolLoop] API returned no choices after 3 retries. Stopping.`);
      if (earlyContent) break;
      return { content: `The AI model returned an error: ${apiError}. Please try again.`, toolResults };
    }
    noChoicesRetries = 0; // reset on success

    const message = choice.message;
    const toolCalls = message.tool_calls || [];
    lastUsage = data.usage;

    // Add assistant message to context — truncate large tool_call args to prevent context overflow
    // IMPORTANT: Must produce valid JSON, otherwise the API rejects with "EOF while parsing a string"
    // Also ensure every tool_call has type: "function" — some APIs (e.g. zAi/GLM) omit it in responses
    // but reject it if missing when sent back.
    const truncatedToolCalls = toolCalls.length ? toolCalls.map((tc: any) => {
      if (!tc.type) tc.type = "function";
      const args = tc.function?.arguments || "";
      const argsStr = typeof args === "string" ? args : JSON.stringify(args);
      if (argsStr.length > 4000) {
        // Build a valid JSON summary instead of slicing mid-string
        try {
          const parsed = typeof args === "object" ? args : JSON.parse(argsStr);
          const summary: Record<string, any> = {};
          for (const [key, val] of Object.entries(parsed)) {
            if (typeof val === "string" && val.length > 500) {
              summary[key] = val.slice(0, 500) + "...(truncated)";
            } else {
              summary[key] = val;
            }
          }
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(summary) } };
        } catch {
          // If JSON parse fails, wrap the truncated text as a valid JSON string
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ _truncated: argsStr.slice(0, 3000) }) } };
        }
      }
      return tc;
    }) : undefined;
    allMessages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: truncatedToolCalls,
    });

    // If no tool calls, check if the LLM is giving up after errors — nudge it to retry
    if (!toolCalls.length) {
      const lastToolFailed = toolResults.length > 0 && (toolResults[toolResults.length - 1]?.result?.ok === false || toolResults[toolResults.length - 1]?.result?.exitCode === 1);
      const contentLooksLikeGivingUp = /\b(error|fail|unable|cannot|couldn'?t|sorry|unfortunately|issue|problem)\b/i.test(message.content || "");

      // Check if sub-agents are still working — do NOT stop if work is pending
      if (sessionId) {
        const workingAgents = getWorkingAgents(sessionId);
        const pendingResults = collectPendingResults(sessionId);
        const pendingBBTasks = getPendingBlackboardTasks(sessionId);
        const hasPendingWork = workingAgents.length > 0 || pendingResults.length > 0 || pendingBBTasks.length > 0;

        if (hasPendingWork) {
          const agentNames = workingAgents.map(a => a.agentName).join(", ");
          const pendingNames = pendingResults.map(r => r.agentName).join(", ");
          const bbTaskInfo = pendingBBTasks.map(t => `${t.taskId}(${t.status})`).join(", ");
          console.log(`[ToolLoop] LLM tried to stop but work pending: agents=[${agentNames}], results=[${pendingNames}], bb_tasks=[${bbTaskInfo}]`);

          // Inject pending results if available
          let pendingInfo = "";
          if (pendingResults.length > 0) {
            pendingInfo = "\n\nResults just arrived from your agents:\n" + pendingResults.map(r => `**${r.agentName}**: ${r.result.slice(0, 3000)}`).join("\n\n");
          }

          // Build specific guidance based on what's pending
          let bbGuidance = "";
          if (pendingBBTasks.length > 0) {
            const openTasks = pendingBBTasks.filter(t => t.status === "open" || t.status === "bidding");
            const awardedTasks = pendingBBTasks.filter(t => t.status === "awarded" || t.status === "in_progress");
            if (openTasks.length > 0) {
              bbGuidance += `\n- ${openTasks.length} blackboard task(s) still need bids/awards: ${openTasks.map(t => t.taskId).join(", ")}. Use bb_read to check bids, then bb_award to assign them.`;
            }
            if (awardedTasks.length > 0) {
              bbGuidance += `\n- ${awardedTasks.length} blackboard task(s) are awarded/in-progress: ${awardedTasks.map(t => t.taskId).join(", ")}. Use wait_result to collect results.`;
            }
          }

          allMessages.push({
            role: "user" as const,
            content: `⚠️ SYSTEM: Do NOT stop yet — you have ${workingAgents.length} agent(s) still working${agentNames ? ` (${agentNames})` : ""}, ${pendingResults.length} pending result(s), and ${pendingBBTasks.length} unfinished blackboard task(s). You MUST:\n1. Use bb_read to check bid status, then bb_award to assign open tasks\n2. Use send_task to deliver work to awarded agents\n3. Use wait_result to collect all agent results\n4. Integrate ALL results into your final answer\n5. Only finish AFTER all tasks are completed\nDo NOT give a partial answer. Do NOT abandon pending work.${bbGuidance}${pendingInfo}`,
          });
          consecutiveErrors = 0;
          continue;
        }
      }

      if (lastToolFailed && contentLooksLikeGivingUp && errorRecoveryAttempts < maxErrorRecoveries && round < maxToolRounds - 1) {
        errorRecoveryAttempts++;
        console.log(`[ToolLoop] LLM tried to stop after error. Nudging to retry (attempt ${errorRecoveryAttempts}/${maxErrorRecoveries})...`);
        allMessages.push({
          role: "user" as const,
          content: `⚠️ SYSTEM: Do NOT stop or explain the error to the user. You MUST fix the problem and complete the task. Analyze what went wrong, try a different approach, and call the appropriate tool again. Common fixes:\n- Wrong file path? Use list_files to find the correct path\n- Missing package? Install it with run_python: import subprocess; subprocess.run(['pip', 'install', 'PACKAGE'], check=True)\n- Syntax error? Fix the code and retry\n- File not found? Check if it's in a different directory (uploads/, data/, etc.)\nDo NOT respond with text — call a tool to fix and retry.`,
        });
        consecutiveErrors = 0;
        continue;
      }

      // Also nudge if the LLM stops with incomplete-sounding content (even without explicit errors)
      const contentLooksIncomplete = /\b(will now|next step|let me|i('ll| will)|working on|in progress|wait for)\b/i.test(message.content || "");
      if (contentLooksIncomplete && errorRecoveryAttempts < maxErrorRecoveries && round < maxToolRounds - 1) {
        errorRecoveryAttempts++;
        console.log(`[ToolLoop] LLM stopped with incomplete-sounding response. Nudging to continue (attempt ${errorRecoveryAttempts}/${maxErrorRecoveries})...`);
        allMessages.push({
          role: "user" as const,
          content: `⚠️ SYSTEM: Your response indicates you have more work to do but you stopped without calling any tools. Do NOT describe what you plan to do — actually DO it by calling the appropriate tools now. Continue working until the task is fully complete.`,
        });
        consecutiveErrors = 0;
        continue;
      }

      earlyContent = message.content || "No response generated.";
      break;
    }

    // Loop detection: same tools with same args called 3 rounds in a row → stop
    // Use tool names + truncated args hash to distinguish explore vs chart vs fix
    // Skip loop detection for agent coordination tools — send_task/wait_result naturally repeat
    const agentCoordTools = new Set(["send_task", "wait_result", "check_agents"]);
    const hasNonAgentTool = toolCalls.some((tc: any) => !agentCoordTools.has(tc.function?.name || ""));
    const currentSignature = toolCalls.map((tc: any) => {
      const name = tc.function?.name || "";
      const args = tc.function?.arguments || "";
      const argSnippet = typeof args === "string" ? args.slice(0, 100) : JSON.stringify(args).slice(0, 100);
      return `${name}:${argSnippet}`;
    }).sort().join("|");
    toolCallHistory.push(currentSignature);
    if (toolCallHistory.length >= 3 && hasNonAgentTool) {
      const last3 = toolCallHistory.slice(-3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        console.log(`[ToolLoop] Loop detected: same tools+args 3 rounds. Breaking.`);
        break;
      }
    }

    // Parse all tool calls first
    const parsedToolCalls: Array<{ tc: any; fnName: string; fnArgs: any }> = [];
    for (const tc of toolCalls) {
      const fnName = tc.function?.name || "";
      let fnArgs: any = {};
      const rawArgs = tc.function?.arguments || "{}";
      if (typeof rawArgs === "object" && rawArgs !== null) {
        fnArgs = rawArgs;
      } else try {
        fnArgs = JSON.parse(rawArgs);
      } catch (parseErr: any) {
        console.error(`[Tool ${fnName}] JSON parse failed:`, parseErr.message);
        console.error(`[Tool ${fnName}] Raw args (first 500):`, rawArgs.slice(0, 500));
        if (fnName === "run_react" || fnName === "run_python") {
          const codeKey = rawArgs.indexOf('"code"');
          if (codeKey !== -1) {
            const valueStart = rawArgs.indexOf('"', codeKey + 6) + 1;
            if (valueStart > 0) {
              let valueEnd = rawArgs.lastIndexOf('"');
              const trailingKeys = ['"title"', '"dependencies"'];
              for (const tk of trailingKeys) {
                const tkPos = rawArgs.lastIndexOf(tk);
                if (tkPos > valueStart) {
                  const commaPos = rawArgs.lastIndexOf(',', tkPos);
                  if (commaPos > valueStart) {
                    const quoteBeforeComma = rawArgs.lastIndexOf('"', commaPos - 1);
                    if (quoteBeforeComma > valueStart) {
                      valueEnd = quoteBeforeComma;
                    }
                  }
                }
              }
              if (valueEnd > valueStart) {
                const codeValue = rawArgs.slice(valueStart, valueEnd)
                  .replace(/\\n/g, "\n")
                  .replace(/\\t/g, "\t")
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, "\\");
                fnArgs = { code: codeValue };
                const titleMatch = rawArgs.match(/"title"\s*:\s*"([^"]*)"/);
                if (titleMatch) fnArgs.title = titleMatch[1];
                const depsMatch = rawArgs.match(/"dependencies"\s*:\s*\[([^\]]*)\]/);
                if (depsMatch) {
                  fnArgs.dependencies = depsMatch[1].split(',').map((s: string) => s.trim().replace(/"/g, '')).filter(Boolean);
                }
                console.log(`[Tool ${fnName}] Recovered code (${codeValue.length} chars)`);
              }
            }
          }
        }
      }
      parsedToolCalls.push({ tc, fnName, fnArgs });
    }

    // Separate parallelizable calls (spawn_subagent, send_task, wait_result) from sequential ones
    const parallelToolNames = new Set(["spawn_subagent", "send_task", "wait_result"]);
    const subagentCalls = parsedToolCalls.filter(p => parallelToolNames.has(p.fnName));
    const otherCalls = parsedToolCalls.filter(p => !parallelToolNames.has(p.fnName));

    // Helper to execute a single tool call and record result
    const executeTool = async (parsed: { tc: any; fnName: string; fnArgs: any }) => {
      const { tc, fnName, fnArgs } = parsed;

      if (fnName === "load_skill") usesSkill = true;

      console.log(`[Tool ${fnName}] args:`, Object.keys(fnArgs), fnArgs.code ? `code(${fnArgs.code.length})` : fnArgs.command || fnArgs.cmd || fnArgs.query || fnArgs.skill || fnArgs.path || "");

      if (onToolCall) onToolCall(fnName, fnArgs);

      let result: any;
      try {
        result = await callTool(fnName, fnArgs, signal, taskId);
      } catch (err: any) {
        result = { ok: false, error: err.message };
      }

      // Don't count wait_result/send_task timeouts as consecutive errors —
      // sub-agents may legitimately take a long time for complex tasks
      const isAgentTimeout = (fnName === "wait_result" || fnName === "send_task") &&
        typeof result?.error === "string" && result.error.toLowerCase().includes("timeout");
      if ((result?.ok === false || result?.exitCode === 1) && !isAgentTimeout) {
        consecutiveErrors++;
        console.log(`[Tool ${fnName}] Failed (${consecutiveErrors} consecutive errors):`, result?.error || result?.stderr || "");
      } else if (isAgentTimeout) {
        console.log(`[Tool ${fnName}] Agent timeout (not counted as error):`, result?.error);
        // Don't reset consecutiveErrors either — just ignore for error counting
      } else {
        consecutiveErrors = 0;
      }

      if (onToolResult) onToolResult(fnName, result);
      toolResults.push({ tool: fnName, result });
      totalToolCalls++;

      // Track file reads and skill loads for post-compact restoration
      if (fnName === "read_file" && result?.content && result?.path) {
        trackFileRead(result.path, result.content);
      }
      if (fnName === "load_skill" && result?.content && fnArgs?.skill) {
        trackInvokedSkill(fnArgs.skill, typeof result.content === "string" ? result.content : JSON.stringify(result.content));
      }

      // Feature 2: Smart tool result compression
      const HARD_MAX = 100_000;
      const baseMaxLen = Math.min(settings.agentToolResultMaxLen || 6000, HARD_MAX);
      const maxLen = fnName === "load_skill" ? Math.min(3000, baseMaxLen) : baseMaxLen;
      let resultStr = compressToolResult(fnName, result, maxLen);

      // If run_python returned warnings (exitCode 0 but stderr has actionable warnings),
      // append a nudge so the LLM knows to fix the issue instead of ignoring it
      if (fnName === "run_python" && result?.warnings && result?.exitCode === 0) {
        resultStr += `\n\n⚠️ IMPORTANT: The code ran but produced warnings that may affect output quality:\n${result.warnings}\nYou should fix the underlying issue and re-run the code to ensure complete, correct output.`;
      }

      return { tc, resultStr };
    };

    // Execute non-subagent tools sequentially first
    for (const parsed of otherCalls) {
      if (signal?.aborted) {
        return { content: earlyContent || "Task was cancelled.", toolResults };
      }
      const { tc, resultStr } = await executeTool(parsed);
      allMessages.push({ role: "tool", content: resultStr, tool_call_id: tc.id });

      if (signal?.aborted) {
        return { content: earlyContent || "Task was cancelled.", toolResults };
      }
      const maxConsecutiveErrors = settings.agentMaxConsecutiveErrors || 3;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        if (errorRecoveryAttempts < maxErrorRecoveries) {
          errorRecoveryAttempts++;
          console.log(`[ToolLoop] ${maxConsecutiveErrors} consecutive errors. Attempting recovery (${errorRecoveryAttempts}/${maxErrorRecoveries})...`);

          // Escalating recovery prompts - get more aggressive with each attempt
          const recoveryStrategies = errorRecoveryAttempts <= 2
            ? `⚠️ SYSTEM: You have had ${maxConsecutiveErrors} consecutive tool errors (recovery attempt ${errorRecoveryAttempts}/${maxErrorRecoveries}). Do NOT give up. Do NOT stop. You MUST complete the task. Analyze the errors above carefully and try a DIFFERENT approach:\n- If a Python package is missing, install it first with: run_python with code "import subprocess; subprocess.run(['pip', 'install', 'PACKAGE_NAME'], check=True)"\n- If a file path is wrong, list files to find the correct path\n- If syntax is wrong, carefully fix the syntax\n- If the approach is fundamentally broken, try an alternative method\n- Simplify your code if it's too complex\n- Break complex operations into smaller steps\n- Add try/except blocks to handle specific errors gracefully\nReset and try again with a corrected approach. You MUST NOT stop until the task is complete.`
            : `🔴 SYSTEM CRITICAL: Recovery attempt ${errorRecoveryAttempts}/${maxErrorRecoveries}. You have failed ${maxConsecutiveErrors} times in a row AGAIN. This is NOT acceptable - you MUST complete the task. Take a completely different strategy:\n- STOP repeating the same approach that keeps failing\n- Strip the code down to the absolute minimum that could work\n- If a library doesn't work, use a completely different library or pure Python\n- If file operations fail, verify paths exist first with os.path.exists()\n- If network requests fail, add proper error handling and retries\n- If data processing fails, print intermediate results to debug\n- Write the code step-by-step: first verify inputs, then process, then output\n- If ALL else fails, break the task into tiny sub-tasks and solve each one separately\nDo NOT apologize. Do NOT explain why you failed. Just FIX IT and CONTINUE.`;

          allMessages.push({
            role: "user" as const,
            content: recoveryStrategies,
          });
          consecutiveErrors = 0; // Reset to give the LLM another chance
        } else {
          // Even after max recoveries, give one final chance with a hard reset prompt instead of breaking
          console.log(`[ToolLoop] ${maxConsecutiveErrors} consecutive errors after ${maxErrorRecoveries} recovery attempts. Injecting final fallback...`);
          allMessages.push({
            role: "user" as const,
            content: `🚨 SYSTEM FINAL FALLBACK: All ${maxErrorRecoveries} recovery attempts exhausted. You MUST now provide a final answer with whatever partial results you have. If you have any output files or partial results from earlier successful steps, summarize them. If you can try ONE more simplified approach, do it now. Otherwise, report what you accomplished and what failed.`,
          });
          consecutiveErrors = 0;
          errorRecoveryAttempts = 0; // Reset to allow one more cycle
          // Do NOT break - let the agent try one more time
        }
      }
      if (totalToolCalls >= maxToolCalls) break;
    }

    // Execute spawn_subagent calls IN PARALLEL for speed
    if (subagentCalls.length > 0 && totalToolCalls < maxToolCalls) {
      if (signal?.aborted) {
        return { content: earlyContent || "Task was cancelled.", toolResults };
      }

      console.log(`[ToolLoop] Running ${subagentCalls.length} sub-agent(s) in PARALLEL...`);

      const subagentPromises = subagentCalls.map(parsed => executeTool(parsed));
      const subagentResults = await Promise.all(subagentPromises);

      // Append all sub-agent results to messages in order
      for (const { tc, resultStr } of subagentResults) {
        allMessages.push({ role: "tool", content: resultStr, tool_call_id: tc.id });
      }

      console.log(`[ToolLoop] All ${subagentCalls.length} sub-agent(s) completed in parallel.`);
    }

    if (totalToolCalls >= maxToolCalls) {
      console.log(`[ToolLoop] Reached max tool calls (${maxToolCalls}). Ending loop.`);
      break;
    }
    // Only break on errors if we've gone through recovery AND the final fallback cycle
    if (consecutiveErrors >= (settings.agentMaxConsecutiveErrors || 3) && errorRecoveryAttempts >= maxErrorRecoveries * 2) {
      console.log(`[ToolLoop] Persistent errors after all recovery cycles. Ending loop.`);
      break;
    }
  }

  console.log(`[ToolLoop] Ended after ${totalToolCalls} tool calls.`);

  // Clear checkpoint on successful completion
  if (sessionId && checkpointEnabled) {
    await clearCheckpoint(sessionId);
  }

  // If no tools were called and we have early content, return it directly (no reflection needed)
  if (earlyContent && totalToolCalls === 0) {
    console.log(`[ToolLoop] No tool calls made. Returning direct response.`);
    return { content: sanitizeToolCallContent(earlyContent), usage: lastUsage, toolResults };
  }

  // === Reflection Loop Check (optional — saves tokens when disabled) ===
  const reflectionEnabled = settings.agentReflectionEnabled ?? false;
  const evalThreshold = settings.agentEvalThreshold ?? 0.7;
  const maxReflectionRetries = settings.agentMaxReflectionRetries ?? 2;

  console.log(`[Reflection] Settings: enabled=${reflectionEnabled}, threshold=${evalThreshold}, maxRetries=${maxReflectionRetries}, toolCalls=${totalToolCalls}`);

  if (reflectionEnabled && totalToolCalls > 0) {
    try {
    // Extract the original user objective from messages
    const userObjective = allMessages
      .filter(m => m.role === "user")
      .map(m => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) return m.content.map((p: any) => p.text || "").join(" ");
        return "";
      })
      .join("\n");

    console.log(`[Reflection] User objective (first 200 chars): ${userObjective.slice(0, 200)}`);

    for (let retryRound = 0; retryRound < maxReflectionRetries; retryRound++) {
      console.log(`[Reflection] Round ${retryRound + 1}/${maxReflectionRetries} — evaluating objective satisfaction...`);

      // Build evaluation prompt
      const evalMessages: ChatMessage[] = [];
      if (systemPrompt) evalMessages.push({ role: "system", content: systemPrompt });

      const toolSummaryForEval = toolResults.map(tr => {
        const r = tr.result;
        if (r?.outputFiles?.length) return `[${tr.tool}] Generated: ${r.outputFiles.join(", ")}`;
        if (r?.ok === false) return `[${tr.tool}] Error: ${r.error || "failed"}`;
        if (r?.stdout) return `[${tr.tool}] ${r.stdout.slice(0, 300)}`;
        return `[${tr.tool}] ${JSON.stringify(r).slice(0, 300)}`;
      }).join("\n");

      evalMessages.push({
        role: "user",
        content: `You are an evaluation judge. Score how well the agent satisfied the user's objective.

USER OBJECTIVE:
${userObjective}

AGENT ACTIONS (${totalToolCalls} tool calls):
${toolSummaryForEval}

LAST ASSISTANT MESSAGE:
${allMessages.filter(m => m.role === "assistant").pop()?.content || "(none)"}

Respond in EXACTLY this JSON format (no other text):
{"score": <0.0-1.0>, "satisfied": <true/false>, "missing": "<what is missing or incomplete, empty string if satisfied>"}

Scoring guide:
- 1.0: Fully satisfied, all parts addressed
- 0.7-0.9: Mostly satisfied, minor gaps
- 0.4-0.6: Partially satisfied, significant gaps
- 0.0-0.3: Not satisfied, major parts missing`
      });

      try {
        const evalData = await llmCall(evalMessages);
        const evalContent = evalData.choices?.[0]?.message?.content || "";
        console.log(`[Reflection] Raw eval response: ${evalContent.slice(0, 300)}`);

        // Parse the evaluation JSON
        const jsonMatch = evalContent.match(/\{[\s\S]*?"score"[\s\S]*?\}/);
        if (!jsonMatch) {
          console.log("[Reflection] Could not parse eval JSON. Skipping reflection.");
          break;
        }

        const evalResult = JSON.parse(jsonMatch[0]);
        const score = parseFloat(evalResult.score) || 0;
        const satisfied = evalResult.satisfied === true;
        const missing = evalResult.missing || "";

        console.log(`[Reflection] Score: ${score}, Satisfied: ${satisfied}, Missing: ${missing.slice(0, 200)}`);

        // If score meets threshold, we're done
        if (score >= evalThreshold || satisfied) {
          console.log(`[Reflection] Score ${score} >= threshold ${evalThreshold}. Objective satisfied.`);
          break;
        }

        // Score below threshold — retry the main agent with guidance on what's missing
        console.log(`[Reflection] Score ${score} < threshold ${evalThreshold}. Re-entering agent loop to address gaps...`);

        allMessages.push({
          role: "system",
          content: `REFLECTION CHECK: Your work scored ${score}/1.0 (threshold: ${evalThreshold}). The evaluation found these gaps:\n${missing}\n\nPlease address what's missing to fully satisfy the user's objective. Use tools as needed.`
        });

        // Run additional tool rounds to address the gaps
        const retryMaxRounds = Math.min(maxToolRounds, 5);
        for (let round = 0; round < retryMaxRounds; round++) {
          let data: any;
          try {
            data = await llmCall(allMessages, { tools: await getTools() });
          } catch (err: any) {
            console.error(`[Reflection retry] LLM call failed: ${err.message}`);
            break;
          }

          const choice = data.choices?.[0];
          if (!choice) break;

          const message = choice.message;
          const retryToolCalls = message.tool_calls || [];

          allMessages.push({
            role: "assistant",
            content: message.content || "",
            tool_calls: retryToolCalls.length ? retryToolCalls : undefined,
          });

          if (!retryToolCalls.length) break; // LLM done

          for (const tc of retryToolCalls) {
            const fnName = tc.function?.name || "";
            let fnArgs: any = {};
            try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { fnArgs = {}; }
            if (onToolCall) onToolCall(fnName, fnArgs);
            let result: any;
            try { result = await callTool(fnName, fnArgs, undefined, taskId); } catch (err: any) { result = { ok: false, error: err.message }; }
            if (onToolResult) onToolResult(fnName, result);
            toolResults.push({ tool: fnName, result });
            totalToolCalls++;
            const resultStr = compressToolResult(fnName, result, Math.min(settings.agentToolResultMaxLen || 6000, 100_000));
            allMessages.push({ role: "tool", content: resultStr, tool_call_id: tc.id });
          }
        }
        // Loop back to re-evaluate
      } catch (err: any) {
        console.error(`[Reflection] Eval failed: ${err.message}`);
        break;
      }
    }
    } catch (outerErr: any) {
      console.error(`[Reflection] Unexpected error in reflection block: ${outerErr.message}`);
    }
  }

  // If agent finished naturally with content and reflection didn't trigger a retry, return early content
  if (earlyContent && !reflectionEnabled) {
    return { content: earlyContent, usage: lastUsage, toolResults };
  }

  console.log(`[ToolLoop] Final total: ${totalToolCalls} tool calls. Generating final response...`);

  // Check if user likely wanted output files but none were generated
  const hasOutputFiles = toolResults.some((tr) => tr.result?.outputFiles?.length > 0);
  const userWantsOutput = allMessages.some((m) => {
    if (m.role !== "user") return false;
    const text = typeof m.content === "string" ? m.content : m.content.map((p) => p.text || "").join(" ");
    return /\b(chart|graph|plot|report|analy[sz]|visual|diagram|figure)\b/i.test(text);
  });

  // If user wanted graphs/analysis but none were generated, do extra rounds to generate them
  if (userWantsOutput && !hasOutputFiles && totalToolCalls > 0) {
    // Collect any error messages from failed tool calls to help LLM fix them
    const errors = toolResults
      .filter((tr) => tr.result?.exitCode === 1 || tr.result?.ok === false)
      .map((tr) => tr.result?.stderr || tr.result?.error || "unknown error")
      .join("\n");

    const errorHint = errors
      ? `\n\nYour previous code had errors:\n${errors.slice(0, 1000)}\n\nFix these errors in your new code.`
      : "";

    console.log("[ToolLoop] User wanted output files but none generated. Nudging LLM to create them...");
    allMessages.push({
      role: "system",
      content: `IMPORTANT: The user asked for charts/graphs/analysis but you have NOT generated any output files yet. You MUST now call run_python to create matplotlib charts and save them as PNG files. Write simple, robust code — avoid complex table formatting. Use plt.savefig('filename.png', dpi=150, bbox_inches='tight') for each chart. Combine reading data + creating charts in one run_python call.${errorHint}`,
    });

    const maxNudgeRounds = 3;
    for (let nudgeRound = 0; nudgeRound < maxNudgeRounds; nudgeRound++) {
      try {
        const nudgeData = await llmCall(allMessages, { tools: await getTools() });
        const nudgeChoice = nudgeData.choices?.[0];
        if (!nudgeChoice?.message?.tool_calls?.length) {
          // LLM responded with text instead of tools
          if (nudgeChoice?.message?.content) {
            return { content: nudgeChoice.message.content, usage: nudgeData.usage, toolResults };
          }
          break;
        }

        const nudgeMsg = nudgeChoice.message;
        allMessages.push({
          role: "assistant",
          content: nudgeMsg.content || "",
          tool_calls: nudgeMsg.tool_calls,
        });

        let nudgeHasOutput = false;
        for (const tc of nudgeMsg.tool_calls) {
          const fnName = tc.function?.name || "";
          let fnArgs: any = {};
          try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { fnArgs = {}; }
          if (onToolCall) onToolCall(fnName, fnArgs);
          let result: any;
          try { result = await callTool(fnName, fnArgs, undefined, taskId); } catch (err: any) { result = { ok: false, error: err.message }; }
          if (onToolResult) onToolResult(fnName, result);
          toolResults.push({ tool: fnName, result });
          totalToolCalls++;
          if (result?.outputFiles?.length > 0) nudgeHasOutput = true;
          const resultStr = compressToolResult(fnName, result, 6000);
          allMessages.push({ role: "tool", content: resultStr, tool_call_id: tc.id });
        }

        // If we got output files, we're done nudging
        if (nudgeHasOutput) {
          console.log("[NudgeLoop] Output files generated successfully.");
          break;
        }

        // If code errored, add a fix hint for next round
        const lastResult = toolResults[toolResults.length - 1]?.result;
        if (lastResult?.exitCode === 1 && lastResult?.stderr) {
          allMessages.push({
            role: "system",
            content: `Your code failed with error:\n${lastResult.stderr.slice(0, 800)}\n\nFix the error and try again. Keep the code simple — avoid complex formatting. Just create basic charts with plt.plot/plt.bar/plt.scatter and plt.savefig.`,
          });
        }
      } catch (err: any) {
        console.error("[NudgeLoop] Failed:", err.message);
        break;
      }
    }
  }

  // Build a compact summary of tool results for the final response
  const toolSummary = toolResults.map((tr) => {
    let brief = "";
    try {
      const r = tr.result;
      if (r?.outputFiles?.length > 0) brief = `Generated: ${r.outputFiles.join(", ")}`;
      else if (r?.ok === false) brief = `Error: ${r.error || "failed"}`;
      else if (r?.stdout) brief = r.stdout.slice(0, 300);
      else if (typeof r === "string") brief = r.slice(0, 300);
      else brief = JSON.stringify(r).slice(0, 300);
    } catch { brief = "(result unavailable)"; }
    return `[${tr.tool}]: ${brief}`;
  }).join("\n");

  // Build a minimal message list for the final summary call to avoid context overflow
  // Keep: system prompt, user messages, and a compact summary — drop all tool call details
  const finalMessages: ChatMessage[] = [];
  for (const m of allMessages) {
    if (m.role === "system" && finalMessages.length === 0) {
      finalMessages.push(m); // keep system prompt
    } else if (m.role === "user") {
      finalMessages.push(m);
    }
  }
  finalMessages.push({
    role: "system",
    content: `You executed ${totalToolCalls} tool calls. Summary:\n${toolSummary}\n\nProvide a clear, helpful response to the user. Mention any generated files. Do NOT call tools. IMPORTANT: Do NOT include any internal tool call syntax, function names, parameter details, or markers like [web_search], [fetch_url], etc. in your response. The user should only see the final results, not the tools you used.`,
  });

  try {
    const data = await llmCall(finalMessages);
    const content = data.choices?.[0]?.message?.content || "";
    if (content) {
      return { content: sanitizeToolCallContent(content), usage: data.usage, toolResults };
    }
  } catch (err: any) {
    console.error("[FinalResponse] Failed to generate summary:", err.message);
  }

  // Absolute fallback: build a simple summary directly
  const outputFiles = toolResults.flatMap((tr) => tr.result?.outputFiles || []);
  const errors = toolResults.filter((tr) => tr.result?.exitCode === 1).map((tr) => tr.result?.stderr?.slice(0, 200) || "").filter(Boolean);
  const stdouts = toolResults.filter((tr) => tr.result?.stdout).map((tr) => tr.result.stdout.slice(0, 500));

  let fallback = "";
  if (outputFiles.length > 0) {
    fallback += `Generated ${outputFiles.length} file(s): ${outputFiles.join(", ")}\n\n`;
  }
  if (stdouts.length > 0) {
    fallback += stdouts.join("\n---\n").slice(0, 3000);
  }
  if (errors.length > 0) {
    fallback += `\n\nSome errors occurred:\n${errors.join("\n")}`;
  }

  return { content: sanitizeToolCallContent(fallback) || "Task completed. Check the output panel for results.", toolResults };
}

// Simple call without tools (backwards compat)
export async function callTigerBot(
  messages: ChatMessage[],
  systemPrompt?: string
): Promise<TigerBotResponse> {
  const { apiKey } = await getApiConfig();
  if (!apiKey) {
    return { content: "TigerBot API key not configured. Go to Settings to add your API key." };
  }

  const allMessages: ChatMessage[] = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  try {
    const data = await llmCall(allMessages);
    return {
      content: data.choices?.[0]?.message?.content || "No response from TigerBot.",
      usage: data.usage,
    };
  } catch (err: any) {
    return { content: `Connection error: ${err.message}` };
  }
}

// Streaming with tool support
export async function streamTigerBotWithTools(
  messages: ChatMessage[],
  systemPrompt: string,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: any) => void,
  onToolResult: (name: string, result: any) => void,
  onDone: (toolResults: Array<{ tool: string; result: any }>) => void
): Promise<void> {
  // Use non-streaming tool loop for reliability, then stream the final answer
  const result = await callTigerBotWithTools(messages, systemPrompt, onToolCall, onToolResult);
  if (result.content) {
    onChunk(result.content);
  }
  onDone(result.toolResults || []);
}

// Legacy streaming (no tools) for backwards compat
export async function streamTigerBot(
  messages: ChatMessage[],
  systemPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void
): Promise<void> {
  const { apiKey, model, apiUrl, isAnthropic, isOAuthToken } = await getApiConfig();
  const settings = await getSettings();

  if (!apiKey) {
    onChunk("API key not configured. Go to Settings to add your API key.");
    onDone();
    return;
  }

  const allMessages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...messages];

  try {
    let response: Response;
    if (isAnthropic) {
      const authHeaders: Record<string, string> = isOAuthToken
        ? { Authorization: `Bearer ${apiKey}` }
        : { "x-api-key": apiKey };
      const { system, messages: anthropicMsgs } = toAnthropicMessages(allMessages);
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          messages: anthropicMsgs,
          system: system || undefined,
          temperature: settings.agentTemperature ?? 0.7,
          max_tokens: 40960,
          stream: true,
        }),
      });
    } else {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: allMessages,
          temperature: settings.agentTemperature ?? 0.7,
          max_tokens: 40960,
          stream: true,
        }),
      });
    }

    if (!response.ok) {
      onChunk(`API Error (${response.status}): ${await response.text()}`);
      onDone();
      return;
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) { onDone(); return; }

    let buffer = "";
    let fullContent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            // Handle both Anthropic and OpenAI streaming formats
            let delta: string | undefined;
            if (isAnthropic) {
              // Anthropic streaming: event types content_block_delta with delta.text
              delta = json.delta?.text;
            } else {
              delta = json.choices?.[0]?.delta?.content;
            }
            if (delta) {
              fullContent += delta;
              onChunk(delta);
            }
          } catch {}
        }
      }
    }
    if (!fullContent.trim()) {
      const result = await callTigerBot(allMessages.map(m => ({ role: m.role as any, content: m.content })));
      if (result.content) onChunk(result.content);
    }
    onDone();
  } catch (err: any) {
    onChunk(`Connection error: ${err.message}`);
    onDone();
  }
}
