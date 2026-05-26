import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createBunWebSocket, serveStatic } from "hono/bun";
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
