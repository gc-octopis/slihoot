/**
 * WebSocket load test for a live session "answer burst".
 *
 * Simulates N participants joining a running live session and submitting their
 * answer to the *currently open* question at the same instant — the worst-case
 * fan-out scenario this server faces. Reports answer latency percentiles and
 * throughput, and (combined with the Redis cache from item ③) lets you compare
 * DB load with Redis on vs off.
 *
 * Prereqs: the server is running, an admin has started a live session AND has
 * opened/started the current question (otherwise submissions are rejected).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 JOIN_CODE=ABC123 COUNT=80 bun scripts/loadtest.ts
 *
 * Optional: ACTIVITY_ID=... to force a specific activity (otherwise auto-detected
 * from the live state pushed on connect).
 */

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const JOIN_CODE = process.env.JOIN_CODE ?? "";
const COUNT = Number(process.env.COUNT ?? 80);
const ACTIVITY_ID_ENV = process.env.ACTIVITY_ID ?? "";

interface Meta {
  liveId: string;
  activityId: string;
  answer: unknown;
  sendTs: number;
}

const latencies: number[] = [];
let recorded = 0;
let errors = 0;
const errorSamples = new Set<string>();

function wsUrl(liveId: string, token: string) {
  const url = new URL(BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("liveId", liveId);
  url.searchParams.set("role", "participant");
  url.searchParams.set("token", token);
  return url.toString();
}

async function join(index: number) {
  const res = await fetch(`${BASE_URL}/api/live-sessions/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ joinCode: JOIN_CODE, nickname: `load-${index}` })
  });
  if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

function buildAnswer(activity: any): unknown {
  if (activity.type === "multiple_choice" || activity.type === "true_false") {
    return { optionId: activity.options?.[0]?.id };
  }
  return { text: `lt-${Math.random().toString(36).slice(2, 8)}` };
}

function pct(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function waitUntil(cond: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function run() {
  if (!JOIN_CODE) {
    console.error("Set JOIN_CODE (the active live session's join code).");
    process.exit(1);
  }

  console.log(`Joining ${COUNT} participants to "${JOIN_CODE}" at ${BASE_URL} ...`);

  const sockets: WebSocket[] = [];
  const meta: Meta[] = [];

  await Promise.all(
    Array.from({ length: COUNT }, async (_, i) => {
      const joined = await join(i);
      const liveId = joined.liveSession.id as string;
      const token = joined.participantToken as string;
      const m: Meta = { liveId, activityId: ACTIVITY_ID_ENV, answer: null, sendTs: 0 };
      const ws = new WebSocket(wsUrl(liveId, token));
      meta[i] = m;
      sockets[i] = ws;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("connect/state timeout")), 15000);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "state_change") {
            const ca = msg.payload?.currentActivity;
            if (ca) {
              if (!m.activityId) m.activityId = ca.id;
              m.answer = buildAnswer(ca);
            }
            clearTimeout(timer);
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(timer);
            reject(new Error(msg.payload?.message ?? "ws error"));
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("ws connection error"));
        };
      });
    })
  );

  console.log("All connected. Firing simultaneous answer burst ...");

  for (let i = 0; i < COUNT; i++) {
    const m = meta[i]!;
    sockets[i]!.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "answer_recorded") {
        latencies.push(performance.now() - m.sendTs);
        recorded += 1;
      } else if (msg.type === "error") {
        errors += 1;
        errorSamples.add(String(msg.payload?.message ?? "unknown"));
      }
    };
  }

  const start = performance.now();
  for (let i = 0; i < COUNT; i++) {
    const m = meta[i]!;
    if (!m.activityId) {
      errors += 1;
      errorSamples.add("no open activity detected");
      continue;
    }
    m.sendTs = performance.now();
    sockets[i]!.send(
      JSON.stringify({
        type: "submit_answer",
        payload: { activityId: m.activityId, answer: m.answer ?? { text: "loadtest" } }
      })
    );
  }

  await waitUntil(() => recorded + errors >= COUNT, 20000);
  const elapsed = performance.now() - start;

  console.log("\n=== Load test result ===");
  console.log(`participants:      ${COUNT}`);
  console.log(`answers recorded:  ${recorded}`);
  console.log(`errors:            ${errors}`);
  console.log(`burst wall-clock:  ${elapsed.toFixed(0)} ms`);
  if (latencies.length) {
    console.log(`latency p50:       ${pct(latencies, 50).toFixed(1)} ms`);
    console.log(`latency p95:       ${pct(latencies, 95).toFixed(1)} ms`);
    console.log(`latency max:       ${Math.max(...latencies).toFixed(1)} ms`);
    console.log(`throughput:        ${(recorded / (elapsed / 1000)).toFixed(1)} answers/s`);
  }
  if (errorSamples.size) {
    console.log(`error samples:     ${[...errorSamples].join(" | ")}`);
  }

  for (const ws of sockets) ws.close();
  process.exit(0);
}

run().catch((error) => {
  console.error("load test failed:", error);
  process.exit(1);
});
