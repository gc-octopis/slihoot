import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { env, assertRuntimeConfig } from "./env";
import { migrate } from "./db";
import {
  isAdminRequest,
  issueAdminToken,
  requireAdmin,
  tokenFromAuthorization,
  verifyAdminToken
} from "./auth";
import {
  authenticateParticipant,
  countParticipants,
  createActivity,
  createEvent,
  createMessage,
  deleteActivity,
  deleteEvent,
  endLiveSession,
  getActivity,
  getEvent,
  getLiveSession,
  getLiveState,
  getMessage,
  joinLiveSession,
  listEvents,
  listMessages,
  moderateMessage,
  reorderActivities,
  setCurrentActivity,
  setParticipantNameVisibility,
  setResultsVisibility,
  startLiveSession,
  submitAnswer,
  touchParticipant,
  updateActivity,
  updateEvent
} from "./store";
import type { LiveMessageRecord, SocketMessage } from "./types";

const { upgradeWebSocket, websocket } = createBunWebSocket();
const app = new Hono();

type ClientRole = "admin" | "participant";

interface SocketClient {
  id: string;
  liveId: string;
  role: ClientRole;
  ws: {
    send(data: string): void;
    close(code?: number, reason?: string): void;
  };
  participantId?: string;
  participantName?: string;
}

const clients = new Map<string, SocketClient>();
const rooms = new Map<string, Set<string>>();
const messageRateLimits = new Map<string, number>();
const revealTimers = new Map<string, ReturnType<typeof setTimeout>>();

type TryCloudflareTunnelStatus = "stopped" | "starting" | "running" | "error";

interface TryCloudflareTunnelState {
  status: TryCloudflareTunnelStatus;
  localUrl: string | null;
  publicUrl: string | null;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  logs: string[];
}

let tryCloudflareRunId = 0;
let tryCloudflareController: AbortController | null = null;
let tryCloudflareProc: Bun.Subprocess | null = null;
let tryCloudflareState: TryCloudflareTunnelState = {
  status: "stopped",
  localUrl: null,
  publicUrl: null,
  pid: null,
  startedAt: null,
  lastError: null,
  logs: []
};

async function findCloudflaredInKnownWindowsLocations() {
  const roots = [
    Bun.env.LOCALAPPDATA ? join(Bun.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages") : "",
    Bun.env.USERPROFILE
      ? join(Bun.env.USERPROFILE, "AppData", "Local", "Microsoft", "WinGet", "Packages")
      : ""
  ].filter(Boolean);

  const checked = new Set<string>();
  for (const root of roots) {
    if (checked.has(root)) continue;
    checked.add(root);

    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.toLowerCase().startsWith("cloudflare.cloudflared_")) continue;

      const candidate = join(root, entry.name, "cloudflared.exe");
      if (await Bun.file(candidate).exists().catch(() => false)) return candidate;
    }
  }

  return null;
}

async function resolveCloudflaredExecutable(): Promise<{ path: string | null; error: string | null }> {
  const configured = String(env.cloudflaredPath ?? "").trim().replace(/^["']|["']$/g, "");
  if (configured) {
    const exists = await Bun.file(configured).exists().catch(() => false);
    if (exists) return { path: configured, error: null };
    return { path: null, error: `CLOUDFLARED_PATH points to a missing file: ${configured}` };
  }

  const found = Bun.which("cloudflared") ?? Bun.which("cloudflared.exe");
  if (found) return { path: found, error: null };

  const wingetPath = await findCloudflaredInKnownWindowsLocations();
  if (wingetPath) return { path: wingetPath, error: null };

  return {
    path: null,
    error:
      'cloudflared not found. Install it (Windows): "winget install -e --id Cloudflare.cloudflared", then restart the backend (bun run dev). Or set CLOUDFLARED_PATH to the full path of cloudflared.exe.'
  };
}

function addTryCloudflareLog(line: string) {
  if (!line) return;
  tryCloudflareState.logs.push(line);
  if (tryCloudflareState.logs.length > 200) {
    tryCloudflareState.logs.splice(0, tryCloudflareState.logs.length - 200);
  }

  if (!tryCloudflareState.publicUrl) {
    const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match?.[0]) {
      tryCloudflareState.publicUrl = match[0];
      tryCloudflareState.status = "running";
    }
  }
}

async function readStreamLines(stream: ReadableStream<Uint8Array> | number | null | undefined) {
  if (!stream || typeof stream === "number") return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      addTryCloudflareLog(line);
    }
  }

  const tail = buffer.trim();
  if (tail) addTryCloudflareLog(tail);
}

function stopTryCloudflareTunnel() {
  tryCloudflareRunId += 1;

  tryCloudflareController?.abort();
  tryCloudflareController = null;

  try {
    tryCloudflareProc?.kill();
  } catch {
    // ignore
  }
  tryCloudflareProc = null;

  tryCloudflareState = {
    status: "stopped",
    localUrl: null,
    publicUrl: null,
    pid: null,
    startedAt: null,
    lastError: null,
    logs: []
  };
}

async function startTryCloudflareTunnel(localPort: number) {
  if (!Number.isFinite(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error("Invalid port.");
  }

  if (tryCloudflareState.status === "starting" || tryCloudflareState.status === "running") {
    return tryCloudflareState;
  }

  stopTryCloudflareTunnel();
  tryCloudflareRunId += 1;
  const runId = tryCloudflareRunId;

  const localUrl = `http://localhost:${localPort}`;
  tryCloudflareState = {
    status: "starting",
    localUrl,
    publicUrl: null,
    pid: null,
    startedAt: new Date().toISOString(),
    lastError: null,
    logs: []
  };

  const controller = new AbortController();
  tryCloudflareController = controller;

  try {
    const resolved = await resolveCloudflaredExecutable();
    if (!resolved.path) {
      tryCloudflareState.status = "error";
      tryCloudflareState.lastError = resolved.error ?? "cloudflared not available.";
      addTryCloudflareLog(tryCloudflareState.lastError);
      return tryCloudflareState;
    }

    const proc = Bun.spawn({
      cmd: [resolved.path, "tunnel", "--url", localUrl],
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      windowsHide: true,
      onExit(_proc, exitCode, _signalCode, error) {
        if (runId !== tryCloudflareRunId) return;
        if (tryCloudflareState.status === "stopped") return;

        if (error) {
          tryCloudflareState.status = "error";
          tryCloudflareState.lastError = error.message ?? "cloudflared exited.";
          return;
        }

        if (exitCode === 0 && tryCloudflareState.status !== "running") {
          tryCloudflareState.status = "error";
          tryCloudflareState.lastError = "cloudflared exited unexpectedly.";
        } else if (exitCode !== 0 && tryCloudflareState.status !== "running") {
          tryCloudflareState.status = "error";
          tryCloudflareState.lastError = `cloudflared exited with code ${exitCode ?? "unknown"}.`;
        }
      }
    });

    proc.unref();

    tryCloudflareProc = proc;
    tryCloudflareState.pid = proc.pid;

    void readStreamLines(proc.stdout);
    void readStreamLines(proc.stderr);

    return tryCloudflareState;
  } catch (error) {
    tryCloudflareState.status = "error";
    tryCloudflareState.lastError =
      error instanceof Error ? error.message : "Failed to start cloudflared.";
    return tryCloudflareState;
  }
}

function socketId() {
  return crypto.randomUUID();
}

function addClient(client: SocketClient) {
  clients.set(client.id, client);
  const room = rooms.get(client.liveId) ?? new Set<string>();
  room.add(client.id);
  rooms.set(client.liveId, room);
}

function removeClient(clientId: string) {
  const client = clients.get(clientId);
  if (!client) return;
  clients.delete(clientId);
  const room = rooms.get(client.liveId);
  room?.delete(clientId);
  if (room?.size === 0) rooms.delete(client.liveId);
}

function send(client: SocketClient, message: SocketMessage) {
  client.ws.send(JSON.stringify(message));
}

function sendError(client: SocketClient, message: string, code = "VALIDATION_ERROR") {
  send(client, {
    type: "error",
    payload: { code, message }
  });
}

function parseSocketData(data: unknown) {
  if (typeof data === "string") return JSON.parse(data) as SocketMessage;
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data)) as SocketMessage;
  }
  return JSON.parse(String(data)) as SocketMessage;
}

function getRoomClients(liveId: string) {
  const room = rooms.get(liveId);
  if (!room) return [];
  return Array.from(room)
    .map((clientId) => clients.get(clientId))
    .filter(Boolean) as SocketClient[];
}

async function broadcastState(liveId: string) {
  const roomClients = getRoomClients(liveId);
  for (const client of roomClients) {
    const state = await getLiveState(liveId, client.role, client.participantId);
    if (state) {
      send(client, {
        type: "state_change",
        payload: state
      });
    }
  }
}

async function scheduleReveal(liveId: string) {
  const existing = revealTimers.get(liveId);
  if (existing) clearTimeout(existing);
  revealTimers.delete(liveId);

  const liveSession = await getLiveSession(liveId);
  if (
    !liveSession ||
    liveSession.status === "ended" ||
    !liveSession.currentActivityId ||
    !liveSession.currentActivityStartedAt
  ) {
    return;
  }

  const activity = await getActivity(liveSession.currentActivityId);
  if (!activity || activity.timeLimitSeconds <= 0) return;

  const startedMs = new Date(liveSession.currentActivityStartedAt).getTime();
  const remaining = activity.timeLimitSeconds * 1000 - (Date.now() - startedMs);
  if (remaining <= 0) return;

  const timer = setTimeout(() => {
    revealTimers.delete(liveId);
    broadcastState(liveId).catch(() => {});
  }, remaining + 50);
  revealTimers.set(liveId, timer);
}

async function broadcastParticipantCount(liveId: string) {
  const participantCount = await countParticipants(liveId);
  for (const client of getRoomClients(liveId)) {
    send(client, {
      type: "participant_joined",
      payload: { liveId, participantCount }
    });
  }
}

async function broadcastResponseSummary(liveId: string, activityId: string) {
  const activity = await getActivity(activityId);
  const liveSession = await getLiveSession(liveId);
  if (!activity || !liveSession) return;

  const adminState = await getLiveState(liveId, "admin");
  const participantState = liveSession.showResults ? await getLiveState(liveId, "participant") : null;

  for (const client of getRoomClients(liveId)) {
    const state = client.role === "admin" ? adminState : participantState;
    if (state?.responseSummary) {
      send(client, {
        type: "response_summary_update",
        payload: {
          liveId,
          activityId,
          responseSummary: state.responseSummary
        }
      });
    }
  }
}

function publicMessageUpdate(message: LiveMessageRecord) {
  return {
    messageId: message.id,
    status: message.status,
    pinned: message.pinned,
    message
  };
}

async function broadcastNewMessage(message: LiveMessageRecord) {
  for (const client of getRoomClients(message.liveSessionId)) {
    if (client.role === "participant" && message.status !== "visible") continue;
    send(client, {
      type: "new_message",
      payload: { message }
    });
  }
}

async function broadcastMessageUpdate(message: LiveMessageRecord) {
  for (const client of getRoomClients(message.liveSessionId)) {
    if (client.role === "admin") {
      send(client, {
        type: "message_updated",
        payload: publicMessageUpdate(message)
      });
      continue;
    }

    send(client, {
      type: "message_updated",
      payload: {
        messageId: message.id,
        status: message.status,
        pinned: message.pinned
      }
    });
  }
}

async function handleSocketMessage(client: SocketClient, message: SocketMessage) {
  switch (message.type) {
    case "submit_answer": {
      if (client.role !== "participant" || !client.participantId) {
        throw new Error("Only participants can submit answers.");
      }
      const payload = message.payload as any;
      const response = await submitAnswer({
        liveId: client.liveId,
        participantId: client.participantId,
        activityId: String(payload.activityId ?? ""),
        answer: payload.answer
      });
      send(client, { type: "answer_recorded", payload: { response } });
      await broadcastResponseSummary(client.liveId, String(payload.activityId ?? ""));
      return;
    }

    case "change_activity": {
      if (client.role !== "admin") throw new Error("Only admin can change activities.");
      const payload = message.payload as any;
      await setCurrentActivity(client.liveId, String(payload.activityId ?? ""));
      await broadcastState(client.liveId);
      await scheduleReveal(client.liveId);
      return;
    }

    case "set_results_visibility": {
      if (client.role !== "admin") throw new Error("Only admin can set result visibility.");
      const payload = message.payload as any;
      await setResultsVisibility(client.liveId, Boolean(payload.showResults));
      await broadcastState(client.liveId);
      return;
    }

    case "set_participant_name_visibility": {
      if (client.role !== "admin") {
        throw new Error("Only admin can set participant name visibility.");
      }
      const payload = message.payload as any;
      await setParticipantNameVisibility(client.liveId, Boolean(payload.showParticipantNames));
      await broadcastState(client.liveId);
      return;
    }

    case "send_message": {
      if (client.role !== "participant" || !client.participantId) {
        throw new Error("Only participants can send messages.");
      }
      const lastSentAt = messageRateLimits.get(client.participantId) ?? 0;
      if (Date.now() - lastSentAt < 2000) {
        throw new Error("Please wait before sending another message.");
      }
      messageRateLimits.set(client.participantId, Date.now());
      const payload = message.payload as any;
      const newMessage = await createMessage({
        liveId: client.liveId,
        participantId: client.participantId,
        content: payload.content
      });
      if (newMessage) await broadcastNewMessage(newMessage);
      return;
    }

    case "moderate_message": {
      if (client.role !== "admin") throw new Error("Only admin can moderate messages.");
      const payload = message.payload as any;
      const action = String(payload.action ?? "");
      if (!["hide", "show", "delete", "pin", "unpin"].includes(action)) {
        throw new Error("Invalid moderation action.");
      }
      const updatedMessage = await moderateMessage({
        liveId: client.liveId,
        messageId: String(payload.messageId ?? ""),
        action: action as any
      });
      if (updatedMessage) await broadcastMessageUpdate(updatedMessage);
      return;
    }

    default:
      throw new Error("Unknown socket message type.");
  }
}

async function readBody(c: Context) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

async function routeJson<T>(
  c: Context,
  callback: () => Promise<T>,
  status = 200
) {
  try {
    const data = await callback();
    return c.json(data, status as any);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return c.json({ error: message }, 400);
  }
}

async function participantFromRequest(c: Context) {
  const token =
    c.req.header("x-participant-token") ?? tokenFromAuthorization(c.req.header("authorization"));
  if (!token) return null;
  return authenticateParticipant(token);
}

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["Content-Type", "Authorization", "X-Participant-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  })
);

app.get("/api/health", (c) => c.json({ ok: true, name: "slihoot" }));

app.post("/api/auth/login", async (c) => {
  const body = await readBody(c);
  if (String((body as any).password ?? "") !== env.adminPassword) {
    return c.json({ error: "Invalid password." }, 401);
  }

  return c.json({
    token: await issueAdminToken()
  });
});

app.get("/api/auth/me", requireAdmin, (c) => c.json({ role: "admin" }));

app.get("/api/system/network", requireAdmin, (c) =>
  routeJson(c, async () => {
    const interfaces = networkInterfaces();
    const ipv4 = new Set<string>();

    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses ?? []) {
        const family = (address as any).family;
        const isV4 = family === "IPv4" || family === 4;
        if (!isV4) continue;
        if ((address as any).internal) continue;
        const value = String((address as any).address ?? "");
        if (!value) continue;
        ipv4.add(value);
      }
    }

    const ranked = Array.from(ipv4)
      .filter((ip) => ip && ip !== "0.0.0.0" && !ip.startsWith("169.254."))
      .sort((a, b) => {
        const rank = (ip: string) => {
          const parts = ip.split(".").map((value) => Number(value));
          if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return 99;
          const [p1, p2] = parts;
          if (p1 === 192 && p2 === 168) return 0;
          if (p1 === 10) return 1;
          if (p1 === 172 && p2 >= 16 && p2 <= 31) return 2;
          return 50;
        };
        return rank(a) - rank(b) || a.localeCompare(b);
      });

    return { ipv4: ranked };
  })
);

app.get("/api/tunnel/trycloudflare", requireAdmin, (c) => c.json(tryCloudflareState));

app.post("/api/tunnel/trycloudflare/start", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const body = (await readBody(c)) as any;
    const port = Number(body.port ?? body.localPort);
    return startTryCloudflareTunnel(port);
  })
);

app.post("/api/tunnel/trycloudflare/stop", requireAdmin, async (c) =>
  routeJson(c, async () => {
    stopTryCloudflareTunnel();
    return tryCloudflareState;
  })
);

app.get("/api/events", requireAdmin, (c) => routeJson(c, () => listEvents()));

app.post("/api/events", requireAdmin, async (c) =>
  routeJson(c, async () => createEvent(await readBody(c)), 201)
);

app.get("/api/events/:eventId", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const event = await getEvent(c.req.param("eventId")!);
    if (!event) throw new Error("Event not found.");
    return event;
  })
);

app.put("/api/events/:eventId", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const event = await updateEvent(c.req.param("eventId")!, await readBody(c));
    if (!event) throw new Error("Event not found.");
    return event;
  })
);

app.delete("/api/events/:eventId", requireAdmin, async (c) =>
  routeJson(c, async () => ({ ok: await deleteEvent(c.req.param("eventId")!) }))
);

app.post("/api/events/:eventId/activities", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const activity = await createActivity(c.req.param("eventId")!, await readBody(c));
    if (!activity) throw new Error("Could not create activity.");
    return activity;
  }, 201)
);

app.put("/api/activities/:activityId", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const activity = await updateActivity(c.req.param("activityId")!, await readBody(c));
    if (!activity) throw new Error("Activity not found.");
    return activity;
  })
);

app.delete("/api/activities/:activityId", requireAdmin, async (c) =>
  routeJson(c, async () => ({ ok: await deleteActivity(c.req.param("activityId")!) }))
);

app.put("/api/events/:eventId/activities/reorder", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const body = (await readBody(c)) as any;
    return reorderActivities(c.req.param("eventId")!, Array.isArray(body.activityIds) ? body.activityIds : []);
  })
);

app.post("/api/events/:eventId/live-sessions", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const liveSession = await startLiveSession(c.req.param("eventId")!);
    if (!liveSession) throw new Error("Event not found.");
    return liveSession;
  }, 201)
);

app.get("/api/live-sessions/:liveId", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const state = await getLiveState(c.req.param("liveId")!, "admin");
    if (!state) throw new Error("Live session not found.");
    return state;
  })
);

app.post("/api/live-sessions/:liveId/end", requireAdmin, async (c) =>
  routeJson(c, async () => {
    const liveId = c.req.param("liveId")!;
    const liveSession = await endLiveSession(liveId);
    await broadcastState(liveId);
    return liveSession;
  })
);

app.post("/api/live-sessions/join", async (c) =>
  routeJson(c, async () => {
    const joined = await joinLiveSession(await readBody(c));
    if (!joined) throw new Error("Live session not found.");
    return joined;
  }, 201)
);

app.get("/api/live-sessions/:liveId/messages", async (c) =>
  routeJson(c, async () => {
    const liveId = c.req.param("liveId")!;
    const isAdmin = await isAdminRequest(c);
    const participant = isAdmin ? null : await participantFromRequest(c);

    if (!isAdmin && (!participant || participant.liveSessionId !== liveId)) {
      throw new Error("Unauthorized.");
    }

    return listMessages(
      liveId,
      isAdmin && c.req.query("includeHidden") === "true",
      Number(c.req.query("limit") ?? 50)
    );
  })
);

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const clientId = socketId();
    const liveId = String(c.req.query("liveId") ?? "");
    const role = c.req.query("role") === "admin" ? "admin" : "participant";
    const token = String(c.req.query("token") ?? c.req.query("participantToken") ?? "");

    return {
      async onOpen(_event, ws) {
        try {
          if (!liveId || !token) throw new Error("Missing WebSocket credentials.");

          if (role === "admin") {
            const payload = await verifyAdminToken(token);
            if (!payload) throw new Error("Invalid admin token.");

            const client: SocketClient = { id: clientId, liveId, role, ws };
            addClient(client);
            await broadcastState(liveId);
            await scheduleReveal(liveId);
            return;
          }

          const participant = await authenticateParticipant(token);
          if (!participant || participant.liveSessionId !== liveId) {
            throw new Error("Invalid participant token.");
          }

          await touchParticipant(participant.id);
          const client: SocketClient = {
            id: clientId,
            liveId,
            role,
            ws,
            participantId: participant.id,
            participantName: participant.nickname
          };
          addClient(client);
          await broadcastState(liveId);
          await broadcastParticipantCount(liveId);
          await scheduleReveal(liveId);
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "error",
              payload: {
                code: "UNAUTHORIZED",
                message: error instanceof Error ? error.message : "Unauthorized."
              }
            })
          );
          ws.close(1008, "Unauthorized");
        }
      },
      async onMessage(event) {
        const client = clients.get(clientId);
        if (!client) return;

        try {
          await handleSocketMessage(client, parseSocketData(event.data));
        } catch (error) {
          sendError(client, error instanceof Error ? error.message : "Unexpected socket error.");
        }
      },
      onClose() {
        removeClient(clientId);
      },
      onError() {
        removeClient(clientId);
      }
    };
  })
);

app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

assertRuntimeConfig();

if (env.autoMigrate) {
  await migrate();
  console.log("[slihoot] database migrations are up to date.");
}

Bun.serve({
  port: env.port,
  fetch: app.fetch,
  websocket
});

console.log(`[slihoot] listening on http://localhost:${env.port}`);
