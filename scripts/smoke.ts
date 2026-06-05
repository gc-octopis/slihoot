/**
 * Smoke e2e test: drives the real running stack through the core happy path and
 * asserts each step. Exits non-zero on any failure so CI can gate on it.
 *
 * Covers the integration layer that typecheck/build can't: MySQL connectivity,
 * migrations, Redis, admin auth, live-session lifecycle and answer submission
 * over WebSocket.
 *
 * Usage (against a running server):
 *   BASE_URL=http://127.0.0.1:3000 ADMIN_PASSWORD=change-me bun scripts/smoke.ts
 */

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "change-me";

let step = 0;
function ok(msg: string) {
  step += 1;
  console.log(`  ✓ [${step}] ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ✗ FAILED: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) fail(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

function wsUrl(liveId: string, role: string, token: string) {
  const url = new URL(BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("liveId", liveId);
  url.searchParams.set("role", role);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Open a WS and resolve once `predicate(message)` is true; rejects on timeout/error. */
function waitForMessage(
  url: string,
  predicate: (msg: any) => boolean,
  opts: { onOpen?: (ws: WebSocket) => void; timeoutMs?: number } = {}
): Promise<{ ws: WebSocket; msg: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout waiting for expected ws message"));
    }, opts.timeoutMs ?? 10000);
    ws.onopen = () => opts.onOpen?.(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`ws error: ${msg.payload?.message}`));
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve({ ws, msg });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws connection error"));
    };
  });
}

async function run() {
  console.log(`smoke test against ${BASE_URL}`);

  // 1. Health
  const health = await api("GET", "/healthz");
  assert(health.status === "ok", `healthz not ok: ${JSON.stringify(health)}`);
  assert(health.checks?.mysql === true, "mysql not healthy");
  ok(`healthz ok (redisEnabled=${health.redisEnabled}, redis=${health.checks?.redis})`);

  // 2. Admin login
  const { token } = await api("POST", "/api/auth/login", { password: ADMIN_PASSWORD });
  assert(typeof token === "string" && token.length > 0, "no admin token returned");
  ok("admin login");

  // 3. Create event
  const event = await api("POST", "/api/events", { title: "smoke event" }, token);
  assert(event.id, "event not created");
  ok(`event created (${event.id})`);

  // 4. Create activity (true/false)
  const activity = await api(
    "POST",
    `/api/events/${event.id}/activities`,
    { type: "true_false", title: "smoke Q", timeLimitSeconds: 30, correctAnswer: { optionId: "true" } },
    token
  );
  assert(activity.id, "activity not created");
  ok(`activity created (${activity.id})`);

  // 5. Start live session
  const live = await api("POST", `/api/events/${event.id}/live-sessions`, {}, token);
  assert(live.id && live.joinCode, "live session not started");
  ok(`live session started (join code ${live.joinCode})`);

  // 6. Admin opens the question
  {
    const { ws } = await waitForMessage(
      wsUrl(live.id, "admin", token),
      (m) => m.type === "state_change" && m.payload?.activityOpen === true,
      { onOpen: (ws) => ws.send(JSON.stringify({ type: "start_activity" })) }
    );
    ws.close();
    ok("admin started the activity (activityOpen)");
  }

  // 7. Participant joins
  const joined = await api("POST", "/api/live-sessions/join", {
    joinCode: live.joinCode,
    nickname: "smoke-bot"
  });
  assert(joined.participantToken && joined.liveSession?.id, "participant join failed");
  ok("participant joined");

  // 8. Participant connects + 9. submits answer, expects answer_recorded.
  // Keep the socket open afterwards so presence (online count) still reflects it.
  const { ws: participantWs } = await waitForMessage(
    wsUrl(live.id, "participant", joined.participantToken),
    (m) => m.type === "answer_recorded",
    {
      onOpen: (ws) => {
        // Give the server a tick to push initial state, then submit.
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: "submit_answer",
                payload: { activityId: activity.id, answer: { optionId: "true" } }
              })
            ),
          300
        );
      }
    }
  );
  ok("participant answer recorded");

  // 10. Admin sees the response in live state (while the participant is online).
  const adminState = await api("GET", `/api/live-sessions/${live.id}`, undefined, token);
  participantWs.close();
  assert(adminState.participantCount >= 1, `participant count not reflected (got ${adminState.participantCount})`);
  assert(adminState.responseSummary?.total >= 1, "response summary did not count the answer");
  ok(`admin state reflects answer (online=${adminState.participantCount}, answers=${adminState.responseSummary.total})`);

  console.log("\nSMOKE TEST PASSED ✅");
  process.exit(0);
}

run().catch((error) => {
  console.error("\nSMOKE TEST ERRORED:", error?.message ?? error);
  process.exit(1);
});
