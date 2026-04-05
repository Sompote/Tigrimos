export interface RemoteInstance {
  id: string;
  name: string;
  url: string;
  token: string;
}

export interface RemoteTaskResult {
  ok: boolean;
  result?: string;
  sessionId?: string;
  error?: string;
}

export async function remoteTask(
  instance: RemoteInstance,
  task: string,
  opts?: {
    pollIntervalMs?: number;
    idleTimeoutMs?: number;
    maxTimeoutMs?: number;
    /** Legacy single timeout — treated as maxTimeoutMs */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Called whenever new progress entries arrive from the remote server */
    onProgress?: (newEntries: string[]) => void;
  }
): Promise<RemoteTaskResult> {
  const pollInterval = opts?.pollIntervalMs ?? 2000;
  const idleTimeout = opts?.idleTimeoutMs ?? 60_000;
  const maxTimeout = opts?.maxTimeoutMs ?? opts?.timeoutMs ?? 1_800_000;
  const signal = opts?.signal;
  const baseUrl = instance.url.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${instance.token}`,
  };

  // Step 1: Submit task via POST /api/remote/task
  let taskId: string;
  let sessionId: string | undefined;
  try {
    const submitRes = await fetch(`${baseUrl}/api/remote/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task }),
      signal,
    });
    if (!submitRes.ok) {
      const txt = await submitRes.text();
      return { ok: false, error: `Failed to submit task: ${submitRes.status} ${txt}` };
    }
    const submitData = await submitRes.json();
    taskId = submitData.taskId;
    sessionId = submitData.sessionId;
  } catch (err: any) {
    return { ok: false, error: `Network error submitting task: ${err.message}` };
  }

  // Step 2: Poll GET /api/remote/task/:taskId with activity-based timeout
  const hardDeadline = Date.now() + maxTimeout;
  let lastActivityAt = Date.now();
  let lastProgressCount = 0;

  while (true) {
    if (signal?.aborted) {
      return { ok: false, sessionId, error: "Aborted" };
    }
    if (Date.now() > hardDeadline) {
      return { ok: false, sessionId, error: `Timed out after ${maxTimeout / 1000}s (hard cap)` };
    }

    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const pollRes = await fetch(`${baseUrl}/api/remote/task/${taskId}`, {
        headers,
        signal,
      });
      if (!pollRes.ok) continue;

      const pollData = await pollRes.json();
      const progress: string[] = pollData.progress || [];

      // Activity check — any new progress resets the idle clock
      if (progress.length > lastProgressCount) {
        // Forward new progress entries to the caller
        if (opts?.onProgress) {
          const newEntries = progress.slice(lastProgressCount);
          opts.onProgress(newEntries);
        }
        lastActivityAt = Date.now();
        lastProgressCount = progress.length;
      }

      // Idle timeout — agent has gone quiet
      if (Date.now() - lastActivityAt > idleTimeout) {
        return { ok: false, sessionId, error: `Idle timeout after ${idleTimeout / 1000}s with no new progress` };
      }

      if (pollData.status === "completed") {
        return { ok: true, result: pollData.result, sessionId: pollData.sessionId };
      }

      if (pollData.status === "error") {
        return { ok: false, sessionId: pollData.sessionId, error: pollData.error || "Remote task failed" };
      }

      // status === "running" — keep polling
    } catch (err: any) {
      if (signal?.aborted) return { ok: false, sessionId, error: "Aborted" };
      // transient error — keep polling
    }
  }
}

/**
 * Test connectivity to a remote instance by checking GET /api/settings/remote-token.
 * This is a lightweight authenticated endpoint — if it responds, the remote is reachable and the token is valid.
 */
export async function testRemoteInstance(instance: RemoteInstance): Promise<{ ok: boolean; message: string }> {
  const baseUrl = instance.url.replace(/\/$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/settings/remote-token`, {
      headers: {
        Authorization: `Bearer ${instance.token}`,
      },
    });
    if (res.status === 401) {
      return { ok: false, message: "Unauthorized — invalid token" };
    }
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, message: `HTTP ${res.status}: ${txt}` };
    }
    return { ok: true, message: "pong" };
  } catch (err: any) {
    return { ok: false, message: err.message };
  }
}
