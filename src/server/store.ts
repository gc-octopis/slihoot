import type {
  ActivityOption,
  ActivityRecord,
  ActivityType,
  EventRecord,
  LiveMessageRecord,
  LiveSessionRecord,
  LiveState,
  MessageStatus,
  ParticipantRecord,
  ResponseRecord,
  ResponseSummary
} from "./types";
import { pool } from "./db";
import { cacheDel, cacheGet, cacheSet, presenceCount } from "./redis";

const activityTypes: ActivityType[] = ["multiple_choice", "true_false", "short_answer", "word_cloud"];

// --- Redis cache layer -----------------------------------------------------
// Only shared, viewer-agnostic, expensive reads are cached. Live-session state
// itself is intentionally NOT cached (cheap PK lookups, and it is the source of
// truth for the live UI). Every entry has a short TTL as a safety net on top of
// explicit invalidation on writes.
const ACTIVITIES_TTL = 10;
const EVENT_TTL = 10;
const SUMMARY_TTL = 3;

// Presence freshness window. A connected participant is refreshed well within
// this window by the server-side heartbeat (see index.ts), so a member only
// falls out of the online set after the connection is actually gone.
export const PRESENCE_TTL_SECONDS = 90;

function activitiesKey(eventId: string) {
  return `cache:activities:${eventId}`;
}

function eventKey(eventId: string) {
  return `cache:event:${eventId}`;
}

function summaryKey(
  liveId: string,
  activityId: string,
  includeResponses: boolean,
  includeParticipantNames: boolean
) {
  return `cache:summary:${liveId}:${activityId}:${includeResponses ? 1 : 0}:${includeParticipantNames ? 1 : 0}`;
}

function summaryKeysFor(liveId: string, activityId: string) {
  return [
    summaryKey(liveId, activityId, true, true),
    summaryKey(liveId, activityId, true, false),
    summaryKey(liveId, activityId, false, true),
    summaryKey(liveId, activityId, false, false)
  ];
}

function id() {
  return crypto.randomUUID();
}

function nowDate() {
  return new Date();
}

function toIso(value: unknown) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

export function sha256(value: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function randomHex(byteLength = 18) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeParticipantToken() {
  return `pt_${randomHex(24)}`;
}

function makeJoinCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) {
    code += alphabet[byte % alphabet.length];
  }
  return code;
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeOptions(type: ActivityType, options: unknown): ActivityOption[] {
  if (type === "short_answer" || type === "word_cloud") return [];

  if (type === "true_false") {
    return [
      { id: "true", label: "是" },
      { id: "false", label: "否" }
    ];
  }

  const rawOptions = Array.isArray(options) ? options : [];
  return rawOptions
    .map((option, index) => {
      if (typeof option === "string") {
        return { id: id(), label: normalizeText(option, 120) || `選項 ${index + 1}` };
      }

      const maybeOption = option as Partial<ActivityOption>;
      return {
        id: normalizeText(maybeOption.id, 80) || id(),
        label: normalizeText(maybeOption.label, 120) || `選項 ${index + 1}`
      };
    })
    .filter((option) => option.label.length > 0)
    .slice(0, 6);
}

function normalizeCorrectAnswer(
  type: ActivityType,
  options: ActivityOption[],
  correctAnswer: unknown
) {
  if (type === "word_cloud") return null;
  const answerObject =
    typeof correctAnswer === "object" && correctAnswer !== null ? (correctAnswer as any) : {};

  if (type === "short_answer") {
    const text = normalizeText(answerObject.text ?? correctAnswer, 500);
    return text ? { text } : null;
  }

  const optionId = normalizeText(answerObject.optionId ?? correctAnswer, 80);
  return options.some((option) => option.id === optionId) ? { optionId } : null;
}

function assertActivityType(type: unknown): ActivityType {
  if (activityTypes.includes(type as ActivityType)) return type as ActivityType;
  throw new Error("Unsupported activity type.");
}

function rowToEvent(row: any): EventRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function rowToActivity(row: any): ActivityRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    type: row.type,
    title: row.title,
    description: row.description ?? "",
    explanation: row.explanation ?? "",
    timeLimitSeconds: Number(row.timeLimitSeconds ?? 0),
    options: parseJson<ActivityOption[]>(row.optionsJson, []),
    correctAnswer: parseJson(row.correctAnswerJson, null),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function rowToLiveSession(row: any): LiveSessionRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    joinCode: row.joinCode,
    status: row.status,
    currentActivityId: row.currentActivityId,
    currentActivityIndex: Number(row.currentActivityIndex ?? 0),
    currentActivityStartedAt: row.currentActivityStartedAt ? toIso(row.currentActivityStartedAt) : null,
    completedActivityIds: parseJson<string[]>(row.completedActivityIds, []),
    showResults: Boolean(row.showResults),
    showParticipantNames: Boolean(row.showParticipantNames),
    startedAt: row.startedAt ? toIso(row.startedAt) : null,
    endedAt: row.endedAt ? toIso(row.endedAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function rowToParticipant(row: any): ParticipantRecord {
  return {
    id: row.id,
    liveSessionId: row.liveSessionId,
    nickname: row.nickname,
    joinedAt: toIso(row.joinedAt),
    lastSeenAt: toIso(row.lastSeenAt)
  };
}

function rowToResponse(row: any): ResponseRecord {
  return {
    id: row.id,
    liveSessionId: row.liveSessionId,
    activityId: row.activityId,
    participantId: row.participantId,
    answer: parseJson(row.answerJson, null),
    receivedAt: toIso(row.receivedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function rowToMessage(row: any): LiveMessageRecord {
  return {
    id: row.id,
    liveSessionId: row.liveSessionId,
    participantId: row.participantId,
    participantName: row.participantName,
    content: row.content,
    status: row.status,
    pinned: Boolean(row.pinned),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    moderatedAt: row.moderatedAt ? toIso(row.moderatedAt) : null
  };
}

export function publicActivity(activity: ActivityRecord): ActivityRecord {
  return {
    ...activity,
    explanation: "",
    correctAnswer: null
  };
}

function clampTimeLimit(value: unknown) {
  const seconds = Math.floor(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, 3600);
}

export async function listEvents() {
  const [rows] = await pool.query(
    `SELECT
      e.id,
      e.title,
      e.description,
      e.created_at AS createdAt,
      e.updated_at AS updatedAt,
      COUNT(DISTINCT a.id) AS activityCount,
      active_ls.id AS activeLiveSessionId,
      active_ls.join_code AS activeLiveJoinCode,
      active_ls.status AS activeLiveStatus,
      active_ls.started_at AS activeLiveStartedAt,
      COUNT(DISTINCT p.id) AS activeParticipantCount
    FROM events e
    LEFT JOIN activities a ON a.event_id = e.id
    LEFT JOIN live_sessions active_ls ON active_ls.id = (
      SELECT ls.id
      FROM live_sessions ls
      WHERE ls.event_id = e.id AND ls.status <> 'ended'
      ORDER BY ls.started_at DESC, ls.created_at DESC
      LIMIT 1
    )
    LEFT JOIN participants p ON p.live_session_id = active_ls.id
    GROUP BY
      e.id,
      e.title,
      e.description,
      e.created_at,
      e.updated_at,
      active_ls.id,
      active_ls.join_code,
      active_ls.status,
      active_ls.started_at
    ORDER BY e.created_at DESC`
  );
  return (rows as any[]).map((row) => ({
    ...rowToEvent(row),
    activityCount: Number(row.activityCount ?? 0),
    activeLiveSession: row.activeLiveSessionId
      ? {
          id: row.activeLiveSessionId,
          joinCode: row.activeLiveJoinCode,
          status: row.activeLiveStatus,
          participantCount: Number(row.activeParticipantCount ?? 0),
          startedAt: row.activeLiveStartedAt ? toIso(row.activeLiveStartedAt) : null
        }
      : null
  }));
}

export async function createEvent(input: { title: unknown; description?: unknown }) {
  const event: EventRecord = {
    id: id(),
    title: normalizeText(input.title, 200) || "未命名活動",
    description: normalizeText(input.description, 2000),
    createdAt: nowDate().toISOString(),
    updatedAt: nowDate().toISOString()
  };

  await pool.execute(
    `INSERT INTO events (id, title, description) VALUES (:id, :title, :description)`,
    {
      id: event.id,
      title: event.title,
      description: event.description
    }
  );

  return getEvent(event.id);
}

export async function getEvent(eventId: string) {
  const key = eventKey(eventId);
  let base: EventRecord | null = null;

  const cached = await cacheGet(key);
  if (cached) {
    try {
      base = JSON.parse(cached) as EventRecord;
    } catch {
      base = null;
    }
  }

  if (!base) {
    const [rows] = await pool.execute(
      `SELECT id, title, description, created_at AS createdAt, updated_at AS updatedAt
       FROM events WHERE id = :eventId`,
      { eventId }
    );
    const row = (rows as any[])[0];
    if (!row) return null;
    base = rowToEvent(row);
    await cacheSet(key, JSON.stringify(base), EVENT_TTL);
  }

  // Activities are cached independently via listActivities().
  const activities = await listActivities(eventId);
  return {
    ...base,
    activities
  };
}

export async function updateEvent(
  eventId: string,
  input: { title?: unknown; description?: unknown }
) {
  const title = normalizeText(input.title, 200);
  const description = normalizeText(input.description, 2000);
  await pool.execute(
    `UPDATE events SET title = :title, description = :description WHERE id = :eventId`,
    {
      eventId,
      title: title || "未命名活動",
      description
    }
  );
  await cacheDel(eventKey(eventId));
  return getEvent(eventId);
}

export async function deleteEvent(eventId: string) {
  const [result] = await pool.execute(`DELETE FROM events WHERE id = :eventId`, { eventId });
  await cacheDel(eventKey(eventId), activitiesKey(eventId));
  return (result as any).affectedRows > 0;
}

export async function listActivities(eventId: string): Promise<ActivityRecord[]> {
  const key = activitiesKey(eventId);
  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as ActivityRecord[];
    } catch {
      /* fall through to DB */
    }
  }

  const [rows] = await pool.execute(
    `SELECT
      id,
      event_id AS eventId,
      type,
      title,
      description,
      explanation,
      time_limit_seconds AS timeLimitSeconds,
      options_json AS optionsJson,
      correct_answer_json AS correctAnswerJson,
      sort_order AS sortOrder,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM activities
    WHERE event_id = :eventId
    ORDER BY sort_order ASC, created_at ASC`,
    { eventId }
  );
  const activities = (rows as any[]).map(rowToActivity);
  await cacheSet(key, JSON.stringify(activities), ACTIVITIES_TTL);
  return activities;
}

export async function createActivity(
  eventId: string,
  input: {
    type: unknown;
    title: unknown;
    description?: unknown;
    explanation?: unknown;
    timeLimitSeconds?: unknown;
    options?: unknown;
    correctAnswer?: unknown;
  }
) {
  const type = assertActivityType(input.type);
  const title = normalizeText(input.title, 200) || "未命名題目";
  const description = normalizeText(input.description, 2000);
  const explanation = normalizeText(input.explanation, 2000);
  const timeLimitSeconds = clampTimeLimit(input.timeLimitSeconds);
  const options = normalizeOptions(type, input.options);

  if (type === "multiple_choice" && options.length < 2) {
    throw new Error("Multiple choice activities need at least two options.");
  }

  const correctAnswer = normalizeCorrectAnswer(type, options, input.correctAnswer);
  if (type !== "word_cloud" && !correctAnswer) {
    throw new Error("請先設定正確答案再新增題目。");
  }

  const [maxRows] = await pool.execute(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM activities WHERE event_id = :eventId`,
    { eventId }
  );
  const sortOrder = Number((maxRows as any[])[0]?.nextOrder ?? 0);
  const activityId = id();

  await pool.execute(
    `INSERT INTO activities
      (id, event_id, type, title, description, explanation, time_limit_seconds, options_json, correct_answer_json, sort_order)
     VALUES
      (:id, :eventId, :type, :title, :description, :explanation, :timeLimitSeconds, :optionsJson, :correctAnswerJson, :sortOrder)`,
    {
      id: activityId,
      eventId,
      type,
      title,
      description,
      explanation,
      timeLimitSeconds,
      optionsJson: stringifyJson(options),
      correctAnswerJson: stringifyJson(correctAnswer),
      sortOrder
    }
  );

  await cacheDel(activitiesKey(eventId));
  return getActivity(activityId);
}

export async function getActivity(activityId: string) {
  const [rows] = await pool.execute(
    `SELECT
      id,
      event_id AS eventId,
      type,
      title,
      description,
      explanation,
      time_limit_seconds AS timeLimitSeconds,
      options_json AS optionsJson,
      correct_answer_json AS correctAnswerJson,
      sort_order AS sortOrder,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM activities
    WHERE id = :activityId`,
    { activityId }
  );
  const row = (rows as any[])[0];
  return row ? rowToActivity(row) : null;
}

export async function updateActivity(
  activityId: string,
  input: {
    type: unknown;
    title: unknown;
    description?: unknown;
    explanation?: unknown;
    timeLimitSeconds?: unknown;
    options?: unknown;
    correctAnswer?: unknown;
  }
) {
  const type = assertActivityType(input.type);
  const title = normalizeText(input.title, 200) || "未命名題目";
  const description = normalizeText(input.description, 2000);
  const explanation = normalizeText(input.explanation, 2000);
  const timeLimitSeconds = clampTimeLimit(input.timeLimitSeconds);
  const options = normalizeOptions(type, input.options);

  if (type === "multiple_choice" && options.length < 2) {
    throw new Error("Multiple choice activities need at least two options.");
  }

  const correctAnswer = normalizeCorrectAnswer(type, options, input.correctAnswer);
  if (type !== "word_cloud" && !correctAnswer) {
    throw new Error("請先設定正確答案再儲存題目。");
  }

  await pool.execute(
    `UPDATE activities
     SET type = :type,
         title = :title,
         description = :description,
         explanation = :explanation,
         time_limit_seconds = :timeLimitSeconds,
         options_json = :optionsJson,
         correct_answer_json = :correctAnswerJson
     WHERE id = :activityId`,
    {
      activityId,
      type,
      title,
      description,
      explanation,
      timeLimitSeconds,
      optionsJson: stringifyJson(options),
      correctAnswerJson: stringifyJson(correctAnswer)
    }
  );

  const updated = await getActivity(activityId);
  if (updated) await cacheDel(activitiesKey(updated.eventId));
  return updated;
}

export async function deleteActivity(activityId: string) {
  const existing = await getActivity(activityId);
  const [result] = await pool.execute(`DELETE FROM activities WHERE id = :activityId`, {
    activityId
  });
  if (existing) await cacheDel(activitiesKey(existing.eventId));
  return (result as any).affectedRows > 0;
}

export async function reorderActivities(eventId: string, activityIds: string[]) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, activityId] of activityIds.entries()) {
      await connection.execute(
        `UPDATE activities SET sort_order = :sortOrder WHERE id = :activityId AND event_id = :eventId`,
        { sortOrder: index, activityId, eventId }
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  await cacheDel(activitiesKey(eventId));
  return listActivities(eventId);
}

async function uniqueJoinCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const joinCode = makeJoinCode();
    const [rows] = await pool.execute(
      `SELECT id FROM live_sessions WHERE join_code = :joinCode LIMIT 1`,
      { joinCode }
    );
    if ((rows as any[]).length === 0) return joinCode;
  }
  throw new Error("Could not generate a unique join code.");
}

export async function startLiveSession(eventId: string) {
  const event = await getEvent(eventId);
  if (!event) return null;

  const [activeRows] = await pool.execute(
    `SELECT id
     FROM live_sessions
     WHERE event_id = :eventId AND status <> 'ended'
     ORDER BY started_at DESC, created_at DESC
     LIMIT 1`,
    { eventId }
  );
  const activeLiveId = (activeRows as any[])[0]?.id;
  if (activeLiveId) return getLiveSession(activeLiveId);

  const activities = await listActivities(eventId);
  const firstActivity = activities[0] ?? null;
  const liveId = id();
  const joinCode = await uniqueJoinCode();

  await pool.execute(
    `INSERT INTO live_sessions
      (id, event_id, join_code, status, current_activity_id, current_activity_index, current_activity_started_at, show_results, started_at)
     VALUES
      (:id, :eventId, :joinCode, 'active', :currentActivityId, 0, :currentActivityStartedAt, FALSE, :startedAt)`,
    {
      id: liveId,
      eventId,
      joinCode,
      currentActivityId: firstActivity?.id ?? null,
      currentActivityStartedAt: null,
      startedAt: nowDate()
    }
  );

  return getLiveSession(liveId);
}

export async function getLiveSession(liveId: string) {
  const [rows] = await pool.execute(
    `SELECT
      id,
      event_id AS eventId,
      join_code AS joinCode,
      status,
      current_activity_id AS currentActivityId,
      current_activity_index AS currentActivityIndex,
      current_activity_started_at AS currentActivityStartedAt,
      completed_activity_ids AS completedActivityIds,
      show_results AS showResults,
      show_participant_names AS showParticipantNames,
      started_at AS startedAt,
      ended_at AS endedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM live_sessions
    WHERE id = :liveId`,
    { liveId }
  );
  const row = (rows as any[])[0];
  return row ? rowToLiveSession(row) : null;
}

export async function endLiveSession(liveId: string) {
  await pool.execute(
    `UPDATE live_sessions SET status = 'ended', ended_at = :endedAt WHERE id = :liveId`,
    { liveId, endedAt: nowDate() }
  );
  return getLiveSession(liveId);
}

export async function setCurrentActivity(liveId: string, activityId: string) {
  const liveSession = await getLiveSession(liveId);
  if (!liveSession) return null;

  const activities = await listActivities(liveSession.eventId);
  const index = activities.findIndex((activity) => activity.id === activityId);
  if (index === -1) throw new Error("Activity does not belong to this live session.");

  const completed = new Set(liveSession.completedActivityIds);
  if (
    liveSession.currentActivityId &&
    liveSession.currentActivityId !== activityId &&
    liveSession.currentActivityStartedAt
  ) {
    completed.add(liveSession.currentActivityId);
  }

  // A question that has already been answered must not re-arm its timer when
  // revisited. Keep it open but anchored in the past so it stays revealed/closed.
  const startedAt = completed.has(activityId) ? new Date(0) : nowDate();

  await pool.execute(
    `UPDATE live_sessions
     SET current_activity_id = :activityId,
         current_activity_index = :activityIndex,
         current_activity_started_at = :startedAt,
         show_results = FALSE,
         completed_activity_ids = :completedActivityIds
     WHERE id = :liveId`,
    {
      liveId,
      activityId,
      activityIndex: index,
      startedAt,
      completedActivityIds: stringifyJson(Array.from(completed))
    }
  );

  return getLiveSession(liveId);
}

export async function startActivity(liveId: string) {
  const liveSession = await getLiveSession(liveId);
  if (!liveSession || liveSession.status === "ended" || !liveSession.currentActivityId) {
    return liveSession;
  }

  await pool.execute(
    `UPDATE live_sessions
     SET current_activity_started_at = :startedAt,
         show_results = FALSE
     WHERE id = :liveId`,
    { liveId, startedAt: nowDate() }
  );

  return getLiveSession(liveId);
}

export async function setResultsVisibility(liveId: string, showResults: boolean) {
  await pool.execute(
    `UPDATE live_sessions SET show_results = :showResults WHERE id = :liveId`,
    { liveId, showResults }
  );
  return getLiveSession(liveId);
}

export async function setParticipantNameVisibility(liveId: string, showParticipantNames: boolean) {
  await pool.execute(
    `UPDATE live_sessions SET show_participant_names = :showParticipantNames WHERE id = :liveId`,
    { liveId, showParticipantNames }
  );
  return getLiveSession(liveId);
}

export async function joinLiveSession(input: { joinCode: unknown; nickname: unknown }) {
  const joinCode = normalizeText(input.joinCode, 8).toUpperCase();
  const nickname = normalizeText(input.nickname, 80) || "匿名";
  const [rows] = await pool.execute(
    `SELECT
      id,
      event_id AS eventId,
      join_code AS joinCode,
      status,
      current_activity_id AS currentActivityId,
      current_activity_index AS currentActivityIndex,
      current_activity_started_at AS currentActivityStartedAt,
      completed_activity_ids AS completedActivityIds,
      show_results AS showResults,
      show_participant_names AS showParticipantNames,
      started_at AS startedAt,
      ended_at AS endedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM live_sessions
    WHERE join_code = :joinCode AND status <> 'ended'
    LIMIT 1`,
    { joinCode }
  );
  const liveRow = (rows as any[])[0];
  if (!liveRow) return null;

  const participantToken = makeParticipantToken();
  const participantId = id();
  await pool.execute(
    `INSERT INTO participants (id, live_session_id, nickname, token_hash)
     VALUES (:id, :liveSessionId, :nickname, :tokenHash)`,
    {
      id: participantId,
      liveSessionId: liveRow.id,
      nickname,
      tokenHash: sha256(participantToken)
    }
  );

  const participant = await getParticipant(participantId);
  return {
    liveSession: rowToLiveSession(liveRow),
    participant,
    participantToken
  };
}

export async function getParticipant(participantId: string) {
  const [rows] = await pool.execute(
    `SELECT
      id,
      live_session_id AS liveSessionId,
      nickname,
      joined_at AS joinedAt,
      last_seen_at AS lastSeenAt
    FROM participants
    WHERE id = :participantId`,
    { participantId }
  );
  const row = (rows as any[])[0];
  return row ? rowToParticipant(row) : null;
}

export async function authenticateParticipant(participantToken: string) {
  const tokenHash = sha256(participantToken);
  const [rows] = await pool.execute(
    `SELECT
      id,
      live_session_id AS liveSessionId,
      nickname,
      joined_at AS joinedAt,
      last_seen_at AS lastSeenAt
    FROM participants
    WHERE token_hash = :tokenHash`,
    { tokenHash }
  );
  const row = (rows as any[])[0];
  return row ? rowToParticipant(row) : null;
}

export async function touchParticipant(participantId: string) {
  await pool.execute(
    `UPDATE participants SET last_seen_at = CURRENT_TIMESTAMP WHERE id = :participantId`,
    { participantId }
  );
}

export async function countParticipants(liveId: string) {
  // Prefer the live "currently online" count from Redis presence.
  const online = await presenceCount(liveId, PRESENCE_TTL_SECONDS);
  if (online !== null) return online;

  // Redis unavailable: fall back to the cumulative join count from MySQL.
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM participants WHERE live_session_id = :liveId`,
    { liveId }
  );
  return Number((rows as any[])[0]?.total ?? 0);
}

function validateAnswer(activity: ActivityRecord, answer: unknown) {
  const answerObject = typeof answer === "object" && answer !== null ? (answer as any) : {};

  if (activity.type === "short_answer") {
    const text = normalizeText(answerObject.text, 500);
    if (!text) throw new Error("Answer text is required.");
    return { text };
  }

  if (activity.type === "word_cloud") {
    const text = normalizeText(answerObject.text, 80);
    if (!text) throw new Error("Word cloud text is required.");
    return { text };
  }

  const optionId = normalizeText(answerObject.optionId, 80);
  const option = activity.options.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error("Invalid answer option.");
  return { optionId };
}

function extractWordCloudTexts(answer: unknown): string[] {
  const answerObject = typeof answer === "object" && answer !== null ? (answer as any) : {};
  const values: unknown[] = Array.isArray(answerObject.texts) ? answerObject.texts : [answerObject.text];
  return values.map((value) => normalizeText(value, 80)).filter(Boolean);
}

export async function submitAnswer(input: {
  liveId: string;
  participantId: string;
  activityId: string;
  answer: unknown;
}) {
  const liveSession = await getLiveSession(input.liveId);
  if (!liveSession || liveSession.status === "ended") {
    throw new Error("Live session is not active.");
  }

  if (liveSession.currentActivityId !== input.activityId) {
    throw new Error("This activity is not currently active.");
  }

  if (!liveSession.currentActivityStartedAt) {
    throw new Error("這一題還沒開始作答。");
  }

  const activity = await getActivity(input.activityId);
  if (!activity) throw new Error("Activity not found.");

  const answer = validateAnswer(activity, input.answer);
  const responseId = id();
  const receivedAt = nowDate();
  const answerForStorage =
    activity.type === "word_cloud"
      ? {
          texts: [
            ...extractWordCloudTexts(
              (await getResponse(input.liveId, input.activityId, input.participantId))?.answer
            ),
            answer.text
          ]
        }
      : answer;

  await pool.execute(
    `INSERT INTO responses
      (id, live_session_id, activity_id, participant_id, answer_json, received_at)
     VALUES
      (:id, :liveId, :activityId, :participantId, :answerJson, :receivedAt)
     ON DUPLICATE KEY UPDATE
      answer_json = VALUES(answer_json),
      received_at = VALUES(received_at)`,
    {
      id: responseId,
      liveId: input.liveId,
      activityId: input.activityId,
      participantId: input.participantId,
      answerJson: stringifyJson(answerForStorage),
      receivedAt
    }
  );

  await cacheDel(...summaryKeysFor(input.liveId, input.activityId));

  return getResponse(input.liveId, input.activityId, input.participantId);
}

export async function getResponse(
  liveId: string,
  activityId: string,
  participantId: string
) {
  const [rows] = await pool.execute(
    `SELECT
      id,
      live_session_id AS liveSessionId,
      activity_id AS activityId,
      participant_id AS participantId,
      answer_json AS answerJson,
      received_at AS receivedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM responses
    WHERE live_session_id = :liveId
      AND activity_id = :activityId
      AND participant_id = :participantId`,
    { liveId, activityId, participantId }
  );
  const row = (rows as any[])[0];
  return row ? rowToResponse(row) : null;
}

export async function getResponseSummary(
  liveId: string,
  activity: ActivityRecord,
  options: { includeResponses?: boolean; includeParticipantNames?: boolean } = {}
): Promise<ResponseSummary> {
  const includeResponses = Boolean(options.includeResponses);
  const includeParticipantNames = Boolean(options.includeParticipantNames);
  const key = summaryKey(liveId, activity.id, includeResponses, includeParticipantNames);

  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as ResponseSummary;
    } catch {
      /* fall through to recompute */
    }
  }

  const result = await computeResponseSummary(liveId, activity, {
    includeResponses,
    includeParticipantNames
  });
  await cacheSet(key, JSON.stringify(result), SUMMARY_TTL);
  return result;
}

async function computeResponseSummary(
  liveId: string,
  activity: ActivityRecord,
  options: { includeResponses?: boolean; includeParticipantNames?: boolean } = {}
) {
  const [rows] = await pool.execute(
    `SELECT
      r.answer_json AS answerJson,
      r.received_at AS receivedAt,
      p.nickname AS participantName
    FROM responses r
    INNER JOIN participants p ON p.id = r.participant_id
    WHERE r.live_session_id = :liveId AND r.activity_id = :activityId
    ORDER BY r.received_at ASC`,
    { liveId, activityId: activity.id }
  );

  const answers = (rows as any[]).map((row) => ({
    answer: parseJson<any>(row.answerJson, {}),
    participantName: row.participantName,
    receivedAt: toIso(row.receivedAt)
  }));
  const correctOptionId =
    typeof activity.correctAnswer === "object" && activity.correctAnswer !== null
      ? normalizeText((activity.correctAnswer as any).optionId, 80)
      : "";

  if (activity.type === "short_answer") {
    const correctText =
      typeof activity.correctAnswer === "object" && activity.correctAnswer !== null
        ? normalizeText((activity.correctAnswer as any).text, 500)
        : "";
    const graded = answers.map((answer) => ({
      participantName: answer.participantName,
      text: normalizeText(answer.answer.text, 500),
      receivedAt: answer.receivedAt,
      isCorrect: correctText ? normalizeText(answer.answer.text, 500) === correctText : null
    }));
    return {
      type: activity.type,
      total: answers.length,
      correctAnswerText: correctText || undefined,
      correctCount: correctText ? graded.filter((entry) => entry.isCorrect).length : undefined,
      responses: options.includeResponses
        ? graded.map((entry) => ({
            participantName: options.includeParticipantNames ? entry.participantName : null,
            text: entry.text,
            isCorrect: entry.isCorrect,
            receivedAt: entry.receivedAt
          }))
        : undefined
    } satisfies ResponseSummary;
  }

  if (activity.type === "word_cloud") {
    const wordEntries = answers.flatMap((answer) =>
      extractWordCloudTexts(answer.answer).map((text) => ({
        text,
        participantName: answer.participantName,
        receivedAt: answer.receivedAt
      }))
    );
    const words = new Map<string, { text: string; count: number }>();

    for (const { text } of wordEntries) {
      const key = text.toLocaleLowerCase();
      const current = words.get(key);
      if (current) {
        current.count += 1;
      } else {
        words.set(key, { text, count: 1 });
      }
    }

    const maxCount = Math.max(1, ...Array.from(words.values()).map((word) => word.count));

    return {
      type: activity.type,
      total: wordEntries.length,
      words: Array.from(words.values())
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, 40)
        .map((word) => ({
          ...word,
          percent: wordEntries.length === 0 ? 0 : Math.round((word.count / wordEntries.length) * 100),
          weight: word.count / maxCount
        }))
    } satisfies ResponseSummary;
  }

  const counts = new Map<string, number>();
  for (const option of activity.options) {
    counts.set(option.id, 0);
  }
  for (const answer of answers) {
    const optionId = normalizeText(answer.answer.optionId, 80);
    if (counts.has(optionId)) {
      counts.set(optionId, (counts.get(optionId) ?? 0) + 1);
    }
  }

  return {
    type: activity.type,
    total: answers.length,
    options: activity.options.map((option) => {
      const count = counts.get(option.id) ?? 0;
      return {
        ...option,
        count,
        percent: answers.length === 0 ? 0 : Math.round((count / answers.length) * 100),
        isCorrect: correctOptionId ? option.id === correctOptionId : undefined
      };
    }),
    responses: options.includeResponses
      ? answers.map((answer) => {
          const optionId = normalizeText(answer.answer.optionId, 80);
          const option = activity.options.find((candidate) => candidate.id === optionId);
          return {
            participantName: options.includeParticipantNames ? answer.participantName : null,
            optionId,
            answerLabel: option?.label ?? "未知選項",
            isCorrect: correctOptionId ? optionId === correctOptionId : null,
            receivedAt: answer.receivedAt
          };
        })
      : undefined
  } satisfies ResponseSummary;
}

export async function getLiveState(
  liveId: string,
  viewer: "admin" | "participant",
  participantId?: string
): Promise<LiveState | null> {
  const liveSession = await getLiveSession(liveId);
  if (!liveSession) return null;

  const event = await getEvent(liveSession.eventId);
  if (!event) return null;

  const activities = await listActivities(liveSession.eventId);
  const currentActivity =
    activities.find((activity) => activity.id === liveSession.currentActivityId) ??
    activities[liveSession.currentActivityIndex] ??
    null;

  const activityOpen = Boolean(currentActivity && liveSession.currentActivityStartedAt);
  const answerClosed = Boolean(
    currentActivity && liveSession.completedActivityIds.includes(currentActivity.id)
  );
  const timeExpired = Boolean(
    currentActivity &&
      currentActivity.timeLimitSeconds > 0 &&
      liveSession.currentActivityStartedAt &&
      Date.now() - new Date(liveSession.currentActivityStartedAt).getTime() >=
        currentActivity.timeLimitSeconds * 1000
  );
  const answerRevealed = Boolean(
    currentActivity &&
      (answerClosed || timeExpired || (liveSession.showResults && currentActivity.timeLimitSeconds <= 0))
  );

  const responseSummary =
    currentActivity && (viewer === "admin" || answerRevealed)
      ? await getResponseSummary(liveId, currentActivity, {
          includeResponses: viewer === "admin",
          includeParticipantNames: viewer === "admin" && liveSession.showParticipantNames
        })
      : null;

  const myResponse =
    participantId && currentActivity
      ? await getResponse(liveId, currentActivity.id, participantId)
      : undefined;

  const participantActivity =
    !currentActivity || !activityOpen
      ? null
      : answerRevealed
        ? currentActivity
        : publicActivity(currentActivity);

  return {
    liveSession,
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt
    },
    activities: viewer === "admin" ? activities : undefined,
    currentActivity: viewer === "admin" ? currentActivity : participantActivity,
    participantCount: await countParticipants(liveId),
    responseSummary,
    serverNow: new Date().toISOString(),
    answerRevealed,
    answerClosed,
    activityOpen,
    me: participantId ? await getParticipant(participantId) : undefined,
    myResponse
  };
}

export async function createMessage(input: {
  liveId: string;
  participantId: string;
  content: unknown;
}) {
  const liveSession = await getLiveSession(input.liveId);
  if (!liveSession || liveSession.status === "ended") {
    throw new Error("Live session is not active.");
  }

  const content = normalizeText(input.content, 200);
  if (!content) throw new Error("Message content is required.");

  const messageId = id();
  await pool.execute(
    `INSERT INTO live_messages (id, live_session_id, participant_id, content)
     VALUES (:id, :liveId, :participantId, :content)`,
    {
      id: messageId,
      liveId: input.liveId,
      participantId: input.participantId,
      content
    }
  );

  return getMessage(messageId);
}

export async function getMessage(messageId: string) {
  const [rows] = await pool.execute(
    `SELECT
      m.id,
      m.live_session_id AS liveSessionId,
      m.participant_id AS participantId,
      p.nickname AS participantName,
      m.content,
      m.status,
      m.pinned,
      m.created_at AS createdAt,
      m.updated_at AS updatedAt,
      m.moderated_at AS moderatedAt
    FROM live_messages m
    INNER JOIN participants p ON p.id = m.participant_id
    WHERE m.id = :messageId`,
    { messageId }
  );
  const row = (rows as any[])[0];
  return row ? rowToMessage(row) : null;
}

export async function listMessages(liveId: string, includeHidden = false, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  const [rows] = await pool.execute(
    `SELECT
      m.id,
      m.live_session_id AS liveSessionId,
      m.participant_id AS participantId,
      p.nickname AS participantName,
      m.content,
      m.status,
      m.pinned,
      m.created_at AS createdAt,
      m.updated_at AS updatedAt,
      m.moderated_at AS moderatedAt
    FROM live_messages m
    INNER JOIN participants p ON p.id = m.participant_id
    WHERE m.live_session_id = :liveId
      AND m.status <> 'deleted'
      AND (:includeHidden = TRUE OR m.status = 'visible')
    ORDER BY m.pinned DESC, m.created_at DESC
    LIMIT ${safeLimit}`,
    { liveId, includeHidden }
  );
  return (rows as any[]).map(rowToMessage).reverse();
}

export async function moderateMessage(input: {
  liveId: string;
  messageId: string;
  action: "hide" | "show" | "delete" | "pin" | "unpin";
}) {
  const actionToStatus: Partial<Record<typeof input.action, MessageStatus>> = {
    hide: "hidden",
    show: "visible",
    delete: "deleted"
  };

  const status = actionToStatus[input.action];

  if (status) {
    await pool.execute(
      `UPDATE live_messages
       SET status = :status,
           pinned = IF(:status = 'deleted', FALSE, pinned),
           moderated_at = :moderatedAt
       WHERE id = :messageId
         AND live_session_id = :liveId
         AND (:status = 'deleted' OR status <> 'deleted')`,
      {
        liveId: input.liveId,
        messageId: input.messageId,
        status,
        moderatedAt: nowDate()
      }
    );
  } else {
    await pool.execute(
      `UPDATE live_messages
       SET pinned = :pinned,
           moderated_at = :moderatedAt
       WHERE id = :messageId AND live_session_id = :liveId AND status <> 'deleted'`,
      {
        liveId: input.liveId,
        messageId: input.messageId,
        pinned: input.action === "pin",
        moderatedAt: nowDate()
      }
    );
  }

  return getMessage(input.messageId);
}
