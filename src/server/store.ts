import type {
  ActivityOption,
  ActivityRecord,
  ActivityType,
  EventRecord,
  EventPresentationRecord,
  LeaderboardEntry,
  LiveMessageRecord,
  LiveSessionRecord,
  LiveState,
  MessageStatus,
  ParticipantRecord,
  ResponseRecord,
  ResponseSummary,
  TimelineItemRecord
} from "./types";
import { pool } from "./db";
import { cacheDel, cacheGet, cacheSet, presenceCount } from "./redis";

const activityTypes: ActivityType[] = [
  "multiple_choice",
  "true_false",
  "short_answer",
  "word_cloud",
  "ranking"
];

// --- Redis cache layer -----------------------------------------------------
// Only shared, viewer-agnostic, expensive reads are cached. Live-session state
// itself is intentionally NOT cached (cheap PK lookups, and it is the source of
// truth for the live UI). Every entry has a short TTL as a safety net on top of
// explicit invalidation on writes.
const ACTIVITIES_TTL = 10;
const EVENT_TTL = 10;
const SUMMARY_TTL = 3;
const LEADERBOARD_TTL = 3;

// Classic Kahoot-style scoring: a wrong answer scores 0; a correct answer
// scores up to MAX_SCORE, scaled down by how long the participant took relative
// to the question's time limit. Answering instantly ~= MAX_SCORE; using the
// full time still earns half. Questions with no time limit award the full
// MAX_SCORE for any correct answer.
const MAX_SCORE = 1000;

function computeScore(isCorrect: boolean, elapsedMs: number, limitSeconds: number) {
  if (!isCorrect) return 0;
  if (limitSeconds <= 0) return MAX_SCORE;
  const fraction = Math.min(1, Math.max(0, elapsedMs / (limitSeconds * 1000)));
  return Math.round(MAX_SCORE * (1 - fraction / 2));
}

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

function leaderboardKey(liveId: string) {
  return `cache:leaderboard:${liveId}`;
}

type DbExecutor = Pick<typeof pool, "execute">;

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
  const answerObject =
    typeof correctAnswer === "object" && correctAnswer !== null ? (correctAnswer as any) : {};

  if (type === "word_cloud") {
    return { allowRepeatAnswers: Boolean(answerObject.allowRepeatAnswers) };
  }

  if (type === "short_answer") {
    const text = normalizeText(answerObject.text ?? correctAnswer, 500);
    return text ? { text } : null;
  }

  // For ranking the correct answer *is* the order the admin entered the items
  // in, so it is derived from the options rather than a separate input.
  if (type === "ranking") {
    return options.length >= 2 ? { order: options.map((option) => option.id) } : null;
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
  const correctAnswer = parseJson(row.correctAnswerJson, null);
  return {
    id: row.id,
    eventId: row.eventId,
    type: row.type,
    title: row.title,
    description: row.description ?? "",
    explanation: row.explanation ?? "",
    timeLimitSeconds: Number(row.timeLimitSeconds ?? 0),
    options: parseJson<ActivityOption[]>(row.optionsJson, []),
    correctAnswer,
    allowRepeatAnswers:
      row.type === "word_cloud" &&
      typeof correctAnswer === "object" &&
      correctAnswer !== null
        ? Boolean((correctAnswer as { allowRepeatAnswers?: unknown }).allowRepeatAnswers)
        : undefined,
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function rowToPresentation(row: any): EventPresentationRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    originalName: row.originalName,
    storedName: row.storedName,
    mimeType: row.mimeType,
    fileSize: Number(row.fileSize ?? 0),
    pageCount: Number(row.pageCount ?? 0),
    pageSizes: parseJson<Array<{ width: number; height: number }>>(row.pageSizesJson, []),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function rowToTimelineItem(row: any): TimelineItemRecord {
  const hasActivity = Boolean(row.activityRecordId);
  return {
    id: row.id,
    eventId: row.eventId,
    type: row.type,
    activityId: row.activityId ?? null,
    presentationId: row.presentationId ?? null,
    pageNumber: row.pageNumber === null || row.pageNumber === undefined ? null : Number(row.pageNumber),
    sortOrder: Number(row.sortOrder ?? 0),
    activity: hasActivity
      ? rowToActivity({
          id: row.activityRecordId,
          eventId: row.activityEventId,
          type: row.activityType,
          title: row.activityTitle,
          description: row.activityDescription,
          explanation: row.activityExplanation,
          timeLimitSeconds: row.activityTimeLimitSeconds,
          optionsJson: row.activityOptionsJson,
          correctAnswerJson: row.activityCorrectAnswerJson,
          sortOrder: row.activitySortOrder,
          createdAt: row.activityCreatedAt,
          updatedAt: row.activityUpdatedAt
        })
      : null,
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
    currentTimelineItemId: row.currentTimelineItemId ?? null,
    currentTimelineIndex: Number(row.currentTimelineIndex ?? 0),
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

// Deterministic Fisher-Yates shuffle (xfnv1a hash -> mulberry32 PRNG). Stable
// for a given seed, so a ranking question's items appear in the same scrambled
// order across every broadcast instead of jumping around on each state update.
function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function publicActivity(activity: ActivityRecord): ActivityRecord {
  const base = { ...activity, explanation: "", correctAnswer: null };
  // For ranking, the stored options order *is* the answer, so scramble the
  // items participants see (stable per question) before reveal.
  if (activity.type === "ranking") {
    return { ...base, options: seededShuffle(activity.options, activity.id) };
  }
  return base;
}

function clampTimeLimit(value: unknown) {
  const seconds = Math.floor(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, 3600);
}

async function listTimelineItemsRaw(eventId: string, connection: DbExecutor = pool) {
  const [rows] = await connection.execute(
    `SELECT id, sort_order AS sortOrder
     FROM event_timeline_items
     WHERE event_id = :eventId
     ORDER BY sort_order ASC, created_at ASC`,
    { eventId }
  );
  return rows as Array<{ id: string; sortOrder: number }>;
}

async function updateTimelineSortOrders(
  eventId: string,
  orderedIds: string[],
  connection: DbExecutor = pool
) {
  for (const [index, itemId] of orderedIds.entries()) {
    await connection.execute(
      `UPDATE event_timeline_items
       SET sort_order = :sortOrder
       WHERE id = :itemId AND event_id = :eventId`,
      { eventId, itemId, sortOrder: index }
    );
  }
}

async function syncActivitySortOrders(eventId: string, connection: DbExecutor = pool) {
  const [rows] = await connection.execute(
    `SELECT activity_id AS activityId
     FROM event_timeline_items
     WHERE event_id = :eventId AND type = 'activity' AND activity_id IS NOT NULL
     ORDER BY sort_order ASC, created_at ASC`,
    { eventId }
  );

  for (const [index, row] of (rows as any[]).entries()) {
    await connection.execute(
      `UPDATE activities
       SET sort_order = :sortOrder
       WHERE id = :activityId AND event_id = :eventId`,
      { eventId, activityId: row.activityId, sortOrder: index }
    );
  }
}

export async function getEventPresentation(eventId: string) {
  const [rows] = await pool.execute(
    `SELECT
      id,
      event_id AS eventId,
      original_name AS originalName,
      stored_name AS storedName,
      mime_type AS mimeType,
      file_size AS fileSize,
      page_count AS pageCount,
      page_sizes_json AS pageSizesJson,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM event_presentations
    WHERE event_id = :eventId
    LIMIT 1`,
    { eventId }
  );
  const row = (rows as any[])[0];
  return row ? rowToPresentation(row) : null;
}

export async function listTimeline(eventId: string) {
  await ensureTimeline(eventId);

  const [rows] = await pool.execute(
    `SELECT
      ti.id,
      ti.event_id AS eventId,
      ti.type,
      ti.activity_id AS activityId,
      ti.presentation_id AS presentationId,
      ti.page_number AS pageNumber,
      ti.sort_order AS sortOrder,
      ti.created_at AS createdAt,
      ti.updated_at AS updatedAt,
      a.id AS activityRecordId,
      a.event_id AS activityEventId,
      a.type AS activityType,
      a.title AS activityTitle,
      a.description AS activityDescription,
      a.explanation AS activityExplanation,
      a.time_limit_seconds AS activityTimeLimitSeconds,
      a.options_json AS activityOptionsJson,
      a.correct_answer_json AS activityCorrectAnswerJson,
      a.sort_order AS activitySortOrder,
      a.created_at AS activityCreatedAt,
      a.updated_at AS activityUpdatedAt
    FROM event_timeline_items ti
    LEFT JOIN activities a ON a.id = ti.activity_id
    WHERE ti.event_id = :eventId
    ORDER BY ti.sort_order ASC, ti.created_at ASC`,
    { eventId }
  );

  return (rows as any[]).map(rowToTimelineItem);
}

async function ensureTimeline(eventId: string) {
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM event_timeline_items WHERE event_id = :eventId`,
    { eventId }
  );
  if (Number((countRows as any[])[0]?.total ?? 0) > 0) return;

  const activities = await listActivities(eventId);
  if (activities.length === 0) return;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, activity] of activities.entries()) {
      await connection.execute(
        `INSERT INTO event_timeline_items
          (id, event_id, type, activity_id, presentation_id, page_number, sort_order)
         VALUES
          (:id, :eventId, 'activity', :activityId, NULL, NULL, :sortOrder)`,
        {
          id: id(),
          eventId,
          activityId: activity.id,
          sortOrder: index
        }
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function insertTimelineItem(
  eventId: string,
  item: {
    id: string;
    type: "pdf_page" | "activity";
    activityId?: string | null;
    presentationId?: string | null;
    pageNumber?: number | null;
  },
  afterTimelineItemId?: string | null,
  connection: DbExecutor = pool
) {
  const existing = await listTimelineItemsRaw(eventId, connection);
  let insertIndex = existing.length;
  if (afterTimelineItemId) {
    const foundIndex = existing.findIndex((candidate) => candidate.id === afterTimelineItemId);
    if (foundIndex === -1) throw new Error("Timeline insertion point not found.");
    insertIndex = foundIndex + 1;
  }

  await connection.execute(
    `INSERT INTO event_timeline_items
      (id, event_id, type, activity_id, presentation_id, page_number, sort_order)
     VALUES
      (:id, :eventId, :type, :activityId, :presentationId, :pageNumber, :sortOrder)`,
    {
      id: item.id,
      eventId,
      type: item.type,
      activityId: item.activityId ?? null,
      presentationId: item.presentationId ?? null,
      pageNumber: item.pageNumber ?? null,
      sortOrder: insertIndex
    }
  );

  const orderedIds = existing.map((candidate) => candidate.id);
  orderedIds.splice(insertIndex, 0, item.id);
  await updateTimelineSortOrders(eventId, orderedIds, connection);
}

export async function saveEventPresentation(input: {
  eventId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  fileSize: number;
  pageCount: number;
  pageSizes: Array<{ width: number; height: number }>;
}) {
  const event = await getEvent(input.eventId);
  if (!event) return null;

  const presentationId = id();
  const pageCount = Math.max(1, Math.min(Math.floor(input.pageCount) || 1, 1000));
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM event_timeline_items
       WHERE event_id = :eventId AND type = 'pdf_page'`,
      { eventId: input.eventId }
    );

    await connection.execute(`DELETE FROM event_presentations WHERE event_id = :eventId`, {
      eventId: input.eventId
    });

    await connection.execute(
      `INSERT INTO event_presentations
        (id, event_id, original_name, stored_name, mime_type, file_size, page_count, page_sizes_json)
       VALUES
        (:id, :eventId, :originalName, :storedName, :mimeType, :fileSize, :pageCount, :pageSizesJson)`,
      {
        id: presentationId,
        eventId: input.eventId,
        originalName: normalizeText(input.originalName, 255) || "presentation.pdf",
        storedName: input.storedName,
        mimeType: normalizeText(input.mimeType, 120) || "application/pdf",
        fileSize: Math.max(0, Math.floor(input.fileSize) || 0),
        pageCount,
        pageSizesJson: stringifyJson(input.pageSizes.slice(0, pageCount))
      }
    );

    const activityItems = await listTimelineItemsRaw(input.eventId, connection);
    const pageItemIds: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const itemId = id();
      pageItemIds.push(itemId);
      await connection.execute(
        `INSERT INTO event_timeline_items
          (id, event_id, type, activity_id, presentation_id, page_number, sort_order)
         VALUES
          (:id, :eventId, 'pdf_page', NULL, :presentationId, :pageNumber, :sortOrder)`,
        {
          id: itemId,
          eventId: input.eventId,
          presentationId,
          pageNumber,
          sortOrder: pageNumber - 1
        }
      );
    }

    await updateTimelineSortOrders(
      input.eventId,
      [...pageItemIds, ...activityItems.map((item) => item.id)],
      connection
    );
    await syncActivitySortOrders(input.eventId, connection);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return getEvent(input.eventId);
}

export async function deleteEventPresentation(eventId: string) {
  const event = await getEvent(eventId);
  if (!event) return null;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM event_timeline_items
       WHERE event_id = :eventId AND type = 'pdf_page'`,
      { eventId }
    );

    await connection.execute(`DELETE FROM event_presentations WHERE event_id = :eventId`, {
      eventId
    });

    await syncActivitySortOrders(eventId, connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return getEvent(eventId);
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
  const presentation = await getEventPresentation(eventId);
  const timeline = await listTimeline(eventId);
  return {
    ...base,
    activities,
    presentation,
    timeline
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
    insertAfterTimelineItemId?: unknown;
  }
) {
  await ensureTimeline(eventId);

  const type = assertActivityType(input.type);
  const title = normalizeText(input.title, 60000) || "未命名題目";
  const description = normalizeText(input.description, 2000);
  const explanation = normalizeText(input.explanation, 2000);
  const timeLimitSeconds = clampTimeLimit(input.timeLimitSeconds);
  const options = normalizeOptions(type, input.options);

  if ((type === "multiple_choice" || type === "ranking") && options.length < 2) {
    throw new Error("Multiple choice and ranking activities need at least two options.");
  }

  const correctAnswer = normalizeCorrectAnswer(type, options, input.correctAnswer);
  if (type !== "word_cloud" && !correctAnswer) {
    throw new Error("請先設定正確答案再新增題目。");
  }

  const activityId = id();
  const timelineItemId = id();
  const insertAfterTimelineItemId = normalizeText(input.insertAfterTimelineItemId, 80) || null;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [maxRows] = await connection.execute(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM activities WHERE event_id = :eventId`,
      { eventId }
    );
    const sortOrder = Number((maxRows as any[])[0]?.nextOrder ?? 0);

    await connection.execute(
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

    await insertTimelineItem(
      eventId,
      {
        id: timelineItemId,
        type: "activity",
        activityId
      },
      insertAfterTimelineItemId,
      connection
    );
    await syncActivitySortOrders(eventId, connection);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

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
  const title = normalizeText(input.title, 60000) || "未命名題目";
  const description = normalizeText(input.description, 2000);
  const explanation = normalizeText(input.explanation, 2000);
  const timeLimitSeconds = clampTimeLimit(input.timeLimitSeconds);
  const options = normalizeOptions(type, input.options);

  if ((type === "multiple_choice" || type === "ranking") && options.length < 2) {
    throw new Error("Multiple choice and ranking activities need at least two options.");
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
  const activity = await getActivity(activityId);
  const [result] = await pool.execute(`DELETE FROM activities WHERE id = :activityId`, {
    activityId
  });
  if (activity) {
    await syncActivitySortOrders(activity.eventId);
    await cacheDel(activitiesKey(activity.eventId));
  }
  return (result as any).affectedRows > 0;
}

export async function reorderActivities(eventId: string, activityIds: string[]) {
  await ensureTimeline(eventId);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, activityId] of activityIds.entries()) {
      await connection.execute(
        `UPDATE activities SET sort_order = :sortOrder WHERE id = :activityId AND event_id = :eventId`,
        { sortOrder: index, activityId, eventId }
      );
    }
    const presentation = await getEventPresentation(eventId);
    if (!presentation) {
      const [rows] = await connection.execute(
        `SELECT id, activity_id AS activityId
         FROM event_timeline_items
         WHERE event_id = :eventId AND type = 'activity'`,
        { eventId }
      );
      const itemByActivityId = new Map(
        (rows as any[]).map((row) => [String(row.activityId), String(row.id)])
      );
      const orderedTimelineIds = activityIds
        .map((activityId) => itemByActivityId.get(activityId))
        .filter(Boolean) as string[];
      await updateTimelineSortOrders(eventId, orderedTimelineIds, connection);
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

export async function reorderTimelineItems(eventId: string, timelineItemIds: string[]) {
  await ensureTimeline(eventId);

  const currentItems = await listTimeline(eventId);
  const currentIds = currentItems.map((item) => item.id);
  const requestedIds = timelineItemIds.map((itemId) => normalizeText(itemId, 80)).filter(Boolean);

  if (requestedIds.length !== currentIds.length) {
    throw new Error("Timeline item list is incomplete.");
  }

  const currentSet = new Set(currentIds);
  const requestedSet = new Set(requestedIds);
  if (requestedSet.size !== requestedIds.length || requestedIds.some((itemId) => !currentSet.has(itemId))) {
    throw new Error("Timeline item list is invalid.");
  }

  const currentPdfIds = currentItems
    .filter((item) => item.type === "pdf_page")
    .map((item) => item.id);
  const currentPdfSet = new Set(currentPdfIds);
  const requestedPdfIds = requestedIds.filter((itemId) => currentPdfSet.has(itemId));
  if (requestedPdfIds.join("|") !== currentPdfIds.join("|")) {
    throw new Error("PDF slide order cannot be changed.");
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await updateTimelineSortOrders(eventId, requestedIds, connection);
    await syncActivitySortOrders(eventId, connection);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return listTimeline(eventId);
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
  const timeline = await listTimeline(eventId);
  const firstItem = timeline[0] ?? null;
  const firstActivity =
    firstItem?.type === "activity"
      ? activities.find((activity) => activity.id === firstItem.activityId) ?? null
      : null;
  const liveId = id();
  const joinCode = await uniqueJoinCode();

  await pool.execute(
    `INSERT INTO live_sessions
      (id, event_id, join_code, status, current_timeline_item_id, current_timeline_index, current_activity_id, current_activity_index, current_activity_started_at, show_results, started_at)
     VALUES
      (:id, :eventId, :joinCode, 'active', :currentTimelineItemId, 0, :currentActivityId, :currentActivityIndex, :currentActivityStartedAt, FALSE, :startedAt)`,
    {
      id: liveId,
      eventId,
      joinCode,
      currentTimelineItemId: firstItem?.id ?? null,
      currentActivityId: firstActivity?.id ?? null,
      currentActivityIndex: firstActivity
        ? activities.findIndex((activity) => activity.id === firstActivity.id)
        : 0,
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
      current_timeline_item_id AS currentTimelineItemId,
      current_timeline_index AS currentTimelineIndex,
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

export async function setCurrentTimelineItem(liveId: string, timelineItemId: string) {
  const liveSession = await getLiveSession(liveId);
  if (!liveSession) return null;

  const activities = await listActivities(liveSession.eventId);
  const timeline = await listTimeline(liveSession.eventId);
  const timelineIndex = timeline.findIndex((item) => item.id === timelineItemId);
  if (timelineIndex === -1) throw new Error("Timeline item does not belong to this live session.");

  const timelineItem = timeline[timelineIndex];
  const activityId = timelineItem.type === "activity" ? timelineItem.activityId : null;
  const activityIndex = activityId
    ? activities.findIndex((activity) => activity.id === activityId)
    : 0;
  if (activityId && activityIndex === -1) {
    throw new Error("Activity does not belong to this live session.");
  }

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
  const startedAt = activityId ? (completed.has(activityId) ? new Date(0) : nowDate()) : null;

  await pool.execute(
    `UPDATE live_sessions
     SET current_timeline_item_id = :timelineItemId,
         current_timeline_index = :timelineIndex,
         current_activity_id = :activityId,
         current_activity_index = :activityIndex,
         current_activity_started_at = :startedAt,
         show_results = FALSE,
         completed_activity_ids = :completedActivityIds
     WHERE id = :liveId`,
    {
      liveId,
      timelineItemId,
      timelineIndex,
      activityId,
      activityIndex,
      startedAt,
      completedActivityIds: stringifyJson(Array.from(completed))
    }
  );

  return getLiveSession(liveId);
}

export async function setCurrentActivity(liveId: string, activityId: string) {
  const liveSession = await getLiveSession(liveId);
  if (!liveSession) return null;

  const timeline = await listTimeline(liveSession.eventId);
  const item = timeline.find(
    (candidate) => candidate.type === "activity" && candidate.activityId === activityId
  );
  if (!item) throw new Error("Activity does not belong to this live session.");
  return setCurrentTimelineItem(liveId, item.id);
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
      current_timeline_item_id AS currentTimelineItemId,
      current_timeline_index AS currentTimelineIndex,
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

  if (activity.type === "ranking") {
    const rawOrder = Array.isArray(answerObject.order) ? answerObject.order : [];
    const order: string[] = rawOrder
      .map((value: unknown) => normalizeText(value, 80))
      .filter(Boolean);
    const optionIds = activity.options.map((option) => option.id);
    const isPermutation =
      order.length === optionIds.length &&
      new Set(order).size === order.length &&
      order.every((optionId: string) => optionIds.includes(optionId));
    if (!isPermutation) throw new Error("Invalid ranking order.");
    return { order };
  }

  const optionId = normalizeText(answerObject.optionId, 80);
  const option = activity.options.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error("Invalid answer option.");
  return { optionId };
}

// Grade a validated answer against the activity's configured correct answer,
// mirroring the correctness logic used when computing response summaries. Word
// clouds and questions without a configured correct answer are never "correct"
// (they simply score 0). `answer` is the normalised output of validateAnswer.
function isAnswerCorrect(
  activity: ActivityRecord,
  answer: { optionId?: string; text?: string; order?: string[] }
) {
  const correct =
    typeof activity.correctAnswer === "object" && activity.correctAnswer !== null
      ? (activity.correctAnswer as any)
      : null;
  if (!correct) return false;

  if (activity.type === "short_answer") {
    const correctText = normalizeText(correct.text, 500);
    return Boolean(correctText) && normalizeText(answer.text, 500) === correctText;
  }

  if (activity.type === "word_cloud") return false;

  if (activity.type === "ranking") {
    const correctOrder: string[] = Array.isArray(correct.order)
      ? correct.order.map((value: unknown) => String(value))
      : [];
    const order = Array.isArray(answer.order) ? answer.order.map((value) => String(value)) : [];
    return (
      correctOrder.length > 0 &&
      order.length === correctOrder.length &&
      order.every((optionId, index) => optionId === correctOrder[index])
    );
  }

  const correctOptionId = normalizeText(correct.optionId, 80);
  return Boolean(correctOptionId) && normalizeText(answer.optionId, 80) === correctOptionId;
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

  const existingResponse = await getResponse(input.liveId, input.activityId, input.participantId);
  if (activity.type === "word_cloud" && existingResponse && !activity.allowRepeatAnswers) {
    throw new Error("這一題不開放重複填答。");
  }

  const answer = validateAnswer(activity, input.answer);
  const responseId = id();
  const receivedAt = nowDate();
  const answerForStorage =
    activity.type === "word_cloud"
      ? {
          texts: [
            ...extractWordCloudTexts(
              activity.allowRepeatAnswers ? existingResponse?.answer : null
            ),
            answer.text
          ]
        }
      : answer;

  // Kahoot-style score, locked in at answer time from correctness + speed.
  const elapsedMs = receivedAt.getTime() - new Date(liveSession.currentActivityStartedAt).getTime();
  const score = computeScore(isAnswerCorrect(activity, answer), elapsedMs, activity.timeLimitSeconds);

  await pool.execute(
    `INSERT INTO responses
      (id, live_session_id, activity_id, participant_id, answer_json, received_at, score)
     VALUES
      (:id, :liveId, :activityId, :participantId, :answerJson, :receivedAt, :score)
     ON DUPLICATE KEY UPDATE
      answer_json = VALUES(answer_json),
      received_at = VALUES(received_at),
      score = VALUES(score)`,
    {
      id: responseId,
      liveId: input.liveId,
      activityId: input.activityId,
      participantId: input.participantId,
      answerJson: stringifyJson(answerForStorage),
      receivedAt,
      score
    }
  );

  await cacheDel(...summaryKeysFor(input.liveId, input.activityId), leaderboardKey(input.liveId));

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

  if (activity.type === "ranking") {
    const correctOrder: string[] =
      typeof activity.correctAnswer === "object" && activity.correctAnswer !== null
        ? ((activity.correctAnswer as any).order ?? []).map((value: unknown) => String(value))
        : [];
    const labelOf = (optionId: string) =>
      activity.options.find((option) => option.id === optionId)?.label ?? "?";
    const orderToText = (order: string[]) =>
      order.map((optionId, index) => `${index + 1}. ${labelOf(optionId)}`).join("  ");

    const graded = answers.map((answer) => {
      const order = Array.isArray(answer.answer.order)
        ? answer.answer.order.map((value: unknown) => String(value))
        : [];
      const isCorrect =
        correctOrder.length > 0 &&
        order.length === correctOrder.length &&
        order.every((optionId: string, index: number) => optionId === correctOrder[index]);
      return { participantName: answer.participantName, order, isCorrect, receivedAt: answer.receivedAt };
    });

    return {
      type: activity.type,
      total: answers.length,
      correctAnswerText: correctOrder.length ? orderToText(correctOrder) : undefined,
      correctOrderLabels: correctOrder.length ? correctOrder.map((optionId) => labelOf(optionId)) : undefined,
      correctCount: correctOrder.length ? graded.filter((entry) => entry.isCorrect).length : undefined,
      responses: options.includeResponses
        ? graded.map((entry) => ({
            participantName: options.includeParticipantNames ? entry.participantName : null,
            text: orderToText(entry.order),
            isCorrect: correctOrder.length ? entry.isCorrect : null,
            receivedAt: entry.receivedAt
          }))
        : undefined
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

// Cumulative scores for every participant in the session, highest first.
// Short-TTL cached and invalidated on each answer, mirroring the summary cache
// so an 80-client broadcast collapses to ~1 DB query.
export async function getLeaderboard(liveId: string): Promise<LeaderboardEntry[]> {
  const key = leaderboardKey(liveId);
  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as LeaderboardEntry[];
    } catch {
      /* fall through to recompute */
    }
  }

  const [rows] = await pool.execute(
    `SELECT
      p.id AS participantId,
      p.nickname AS nickname,
      COALESCE(SUM(r.score), 0) AS score,
      COUNT(r.id) AS answers
    FROM participants p
    LEFT JOIN responses r
      ON r.participant_id = p.id AND r.live_session_id = :liveId
    WHERE p.live_session_id = :liveId
    GROUP BY p.id, p.nickname
    ORDER BY score DESC, answers DESC, p.joined_at ASC`,
    { liveId }
  );

  const entries: LeaderboardEntry[] = (rows as any[]).map((row, index) => ({
    participantId: String(row.participantId),
    nickname: String(row.nickname),
    score: Number(row.score) || 0,
    answers: Number(row.answers) || 0,
    rank: index + 1
  }));

  await cacheSet(key, JSON.stringify(entries), LEADERBOARD_TTL);
  return entries;
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
  const timeline = await listTimeline(liveSession.eventId);
  const presentation = await getEventPresentation(liveSession.eventId);
  const currentTimelineItem =
    timeline.find((item) => item.id === liveSession.currentTimelineItemId) ??
    timeline[liveSession.currentTimelineIndex] ??
    null;
  const currentActivity =
    currentTimelineItem?.type === "activity"
      ? currentTimelineItem.activity ??
        activities.find((activity) => activity.id === currentTimelineItem.activityId) ??
        null
      : activities.find((activity) => activity.id === liveSession.currentActivityId) ??
        (timeline.length === 0 ? activities[liveSession.currentActivityIndex] : null) ??
        null;

  const activityOpen = Boolean(
    currentActivity && liveSession.status !== "ended" && liveSession.currentActivityStartedAt
  );
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
    viewer === "participant" && liveSession.status === "ended"
      ? null
      : !currentActivity || !activityOpen
      ? null
      : answerRevealed
        ? currentActivity
        : publicActivity(currentActivity);

  const fullLeaderboard = await getLeaderboard(liveId);
  const myEntry = participantId
    ? fullLeaderboard.find((entry) => entry.participantId === participantId)
    : undefined;

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
    timeline: viewer === "admin" ? timeline : undefined,
    presentation: viewer === "admin" ? presentation : undefined,
    currentTimelineItem: viewer === "admin" ? currentTimelineItem : null,
    currentActivity: viewer === "admin" ? currentActivity : participantActivity,
    participantCount: await countParticipants(liveId),
    responseSummary,
    serverNow: new Date().toISOString(),
    answerRevealed,
    answerClosed,
    activityOpen,
    leaderboard: fullLeaderboard.slice(0, 10),
    myScore: participantId ? (myEntry?.score ?? 0) : undefined,
    myRank: participantId ? (myEntry?.rank ?? null) : undefined,
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

// Render a stored answer as a human-readable string for data export.
function answerToText(activity: ActivityRecord, answer: any): string {
  if (activity.type === "short_answer") return normalizeText(answer?.text, 500);
  if (activity.type === "word_cloud") {
    const texts = Array.isArray(answer?.texts) ? answer.texts : [answer?.text];
    return texts.map((value: unknown) => normalizeText(value, 80)).filter(Boolean).join(", ");
  }
  if (activity.type === "ranking") {
    const order = Array.isArray(answer?.order) ? answer.order : [];
    return order
      .map((optionId: unknown) =>
        activity.options.find((option) => option.id === String(optionId))?.label ?? "?"
      )
      .join(" → ");
  }
  const optionId = normalizeText(answer?.optionId, 80);
  return activity.options.find((option) => option.id === optionId)?.label ?? optionId;
}

export interface EventExport {
  exportedAt: string;
  event: { id: string; title: string; description: string };
  activities: Array<{
    id: string;
    sortOrder: number;
    type: ActivityType;
    title: string;
    timeLimitSeconds: number;
    options: ActivityOption[];
    correctAnswer: unknown;
  }>;
  liveSessions: Array<{
    id: string;
    joinCode: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
  }>;
  responses: Array<{
    liveSessionId: string;
    joinCode: string;
    activityId: string;
    activityTitle: string;
    activityType: string;
    questionNumber: number | null;
    participantId: string;
    nickname: string;
    answer: string;
    correct: boolean;
    score: number;
    receivedAt: string;
  }>;
}

// Gather everything recorded for an event (its questions and every answer
// across all of its live sessions) for download. Returns null if not found.
export async function exportEventData(eventId: string): Promise<EventExport | null> {
  const event = await getEvent(eventId);
  if (!event) return null;

  const activities = await listActivities(eventId);
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));

  const [sessionRows] = await pool.execute(
    `SELECT id, join_code AS joinCode, status,
            started_at AS startedAt, ended_at AS endedAt
     FROM live_sessions
     WHERE event_id = :eventId
     ORDER BY created_at ASC`,
    { eventId }
  );

  const [responseRows] = await pool.execute(
    `SELECT
      r.live_session_id AS liveSessionId,
      ls.join_code AS joinCode,
      r.activity_id AS activityId,
      r.participant_id AS participantId,
      p.nickname AS nickname,
      r.answer_json AS answerJson,
      r.score AS score,
      r.received_at AS receivedAt
    FROM responses r
    INNER JOIN live_sessions ls ON ls.id = r.live_session_id
    INNER JOIN participants p ON p.id = r.participant_id
    WHERE ls.event_id = :eventId
    ORDER BY ls.created_at ASC, r.received_at ASC`,
    { eventId }
  );

  const responses = (responseRows as any[]).map((row) => {
    const activity = activityById.get(row.activityId);
    const answer = parseJson<any>(row.answerJson, {});
    const score = Number(row.score) || 0;
    return {
      liveSessionId: String(row.liveSessionId),
      joinCode: String(row.joinCode),
      activityId: String(row.activityId),
      activityTitle: activity?.title ?? "",
      activityType: activity?.type ?? "",
      questionNumber: activity ? activity.sortOrder + 1 : null,
      participantId: String(row.participantId),
      nickname: String(row.nickname),
      answer: activity ? answerToText(activity, answer) : JSON.stringify(answer),
      correct: score > 0,
      score,
      receivedAt: toIso(row.receivedAt)
    };
  });

  return {
    exportedAt: new Date().toISOString(),
    event: { id: event.id, title: event.title, description: event.description },
    activities: activities.map((activity) => ({
      id: activity.id,
      sortOrder: activity.sortOrder,
      type: activity.type,
      title: activity.title,
      timeLimitSeconds: activity.timeLimitSeconds,
      options: activity.options,
      correctAnswer: activity.correctAnswer
    })),
    liveSessions: (sessionRows as any[]).map((row) => ({
      id: String(row.id),
      joinCode: String(row.joinCode),
      status: String(row.status),
      startedAt: row.startedAt ? toIso(row.startedAt) : null,
      endedAt: row.endedAt ? toIso(row.endedAt) : null
    })),
    responses
  };
}
