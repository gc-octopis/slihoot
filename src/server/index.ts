import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { env, assertRuntimeConfig } from "./env";
import { migrate, pool } from "./db";
import {
  closeRedis,
  presenceRemove,
  presenceTouch,
  rateLimitHit,
  redisEnabled,
  redisPing
} from "./redis";
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
  PRESENCE_TTL_SECONDS,
  reorderActivities,
  setCurrentActivity,
  startActivity,
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

function handleDisconnect(clientId: string) {
  const client = clients.get(clientId);
  removeClient(clientId);
  if (client?.participantId) {
    void presenceRemove(client.liveId, client.participantId)
      .then(() => broadcastParticipantCount(client.liveId))
      .catch(() => {});
  }
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
      if (!(await allowRateLimit(`rl:ans:${client.participantId}`, 10, 5))) {
        throw new Error("作答太頻繁,請稍候再試。");
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

    case "start_activity": {
      if (client.role !== "admin") throw new Error("Only admin can start activities.");
      await startActivity(client.liveId);
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
      if (!(await allowRateLimit(`rl:msg:${client.participantId}`, 1, 2))) {
        throw new Error("Please wait before sending another message.");
      }
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

// Skip the every-10s /healthz probe to keep request logs (and disk) low-noise.
const requestLogger = logger();
app.use("*", (c, next) => (c.req.path === "/healthz" ? next() : requestLogger(c, next)));

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["Content-Type", "Authorization", "X-Participant-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  })
);

function clientIp(c: Context) {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * Fixed-window rate limit backed by Redis. Returns true when the request is
 * allowed. Fails open (allows) when Redis is unavailable — rate limiting is an
 * optimisation/abuse-control layer, not a hard dependency.
 */
async function allowRateLimit(key: string, limit: number, windowSeconds: number) {
  const count = await rateLimitHit(key, windowSeconds);
  return count === null || count <= limit;
}

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
    if (!(await allowRateLimit(`rl:join:${clientIp(c)}`, env.rateLimit.joinPerMinute, 60))) {
      throw new Error("加入太頻繁,請稍候再試。");
    }
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
          await presenceTouch(liveId, participant.id, PRESENCE_TTL_SECONDS);
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
        handleDisconnect(clientId);
      },
      onError() {
        handleDisconnect(clientId);
      }
    };
  })
);

app.get("/healthz", async (c) => {
  const checks = { mysql: false, redis: false };

  try {
    await pool.query("SELECT 1");
    checks.mysql = true;
  } catch {
    checks.mysql = false;
  }

  checks.redis = redisEnabled ? await redisPing() : false;

  // MySQL is the hard dependency; Redis is an optional optimisation layer.
  const ok = checks.mysql;
  return c.json(
    { status: ok ? "ok" : "degraded", redisEnabled, checks },
    ok ? 200 : 503
  );
});

app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

assertRuntimeConfig();

if (env.autoMigrate) {
  await migrate();
  console.log("[slihoot] database migrations are up to date.");
}

// Presence heartbeat: refresh the online TTL for every connected participant so
// Redis presence reflects live connections without requiring client changes.
const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (client.participantId) {
      void presenceTouch(client.liveId, client.participantId, PRESENCE_TTL_SECONDS);
    }
  }
}, 30_000);

const server = Bun.serve({
  port: env.port,
  fetch: app.fetch,
  websocket
});

// Graceful shutdown: on SIGTERM/SIGINT (e.g. `docker compose stop` or a deploy
// restart), stop accepting connections and release MySQL/Redis cleanly so we
// don't drop sockets mid-write or leak pooled connections.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[slihoot] received ${signal}, shutting down gracefully...`);

  clearInterval(heartbeat);
  for (const timer of revealTimers.values()) clearTimeout(timer);
  revealTimers.clear();

  for (const client of clients.values()) {
    try {
      client.ws.close(1001, "server shutting down");
    } catch {
      /* ignore */
    }
  }

  try {
    await server.stop(true);
  } catch {
    /* ignore */
  }
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  closeRedis();

  console.log("[slihoot] shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[slihoot] listening on http://localhost:${env.port}`);
