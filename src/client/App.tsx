import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type {
  ActiveLiveSessionSummary,
  ActivityOption,
  ActivityRecord,
  ActivityType,
  EventRecord,
  LiveMessageRecord,
  LiveSessionRecord,
  LiveState,
  ResponseRecord,
  ResponseSummary,
  SocketMessage
} from "../server/types";
import {
  ADMIN_TOKEN_KEY,
  api,
  clearAdminToken,
  getAdminToken,
  getParticipantSession,
  PARTICIPANT_LIVE_KEY,
  PARTICIPANT_TOKEN_KEY,
  saveParticipantSession,
  setAdminToken
} from "./api";

type EventListItem = EventRecord & {
  activityCount: number;
  activeLiveSession: ActiveLiveSessionSummary | null;
};
type EventDetail = EventRecord & { activities: ActivityRecord[] };
type ActivityDraft = {
  type: ActivityType;
  title: string;
  description: string;
  explanation: string;
  timeLimitSeconds: number;
  options: ActivityOption[];
  correctOptionId: string;
  correctText: string;
};

type TryCloudflareTunnelState = {
  status: "stopped" | "starting" | "running" | "error";
  localUrl: string | null;
  publicUrl: string | null;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  logs: string[];
};

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const listener = () => setPath(window.location.pathname);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  return path;
}

function wsUrl(params: Record<string, string>) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const search = new URLSearchParams(params);
  return `${protocol}//${window.location.host}/ws?${search.toString()}`;
}

async function copyToClipboard(text: string) {
  if (!text) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function useLiveSocket(options: {
  liveId: string | null;
  role: "admin" | "participant";
  token: string | null;
  onMessage: (message: SocketMessage) => void;
  onError?: (message: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(options.onMessage);
  const onErrorRef = useRef(options.onError);

  useEffect(() => {
    onMessageRef.current = options.onMessage;
    onErrorRef.current = options.onError;
  }, [options.onMessage, options.onError]);

  useEffect(() => {
    if (!options.liveId || !options.token) return;

    let stopped = false;
    let retryTimer: number | undefined;

    const connect = () => {
      const socket = new WebSocket(
        wsUrl({
          liveId: options.liveId!,
          role: options.role,
          token: options.token!
        })
      );
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) {
          retryTimer = window.setTimeout(connect, 1200);
        }
      };
      socket.onerror = () => setConnected(false);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as SocketMessage;
        if (message.type === "error") {
          onErrorRef.current?.((message.payload as any).message ?? "WebSocket error.");
        }
        onMessageRef.current(message);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [options.liveId, options.role, options.token]);

  const send = useCallback((type: string, payload: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify({ type, payload }));
    return true;
  }, []);

  return { connected, send };
}

function useServerCountdown(state: LiveState | null) {
  const activityId = state?.currentActivity?.id ?? null;
  const startedAt = state?.liveSession.currentActivityStartedAt ?? null;
  const limit = state?.currentActivity?.timeLimitSeconds ?? 0;
  const offsetRef = useRef(0);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (state?.serverNow) {
      offsetRef.current = new Date(state.serverNow).getTime() - Date.now();
    }
  }, [state?.serverNow]);

  useEffect(() => {
    if (!activityId || !startedAt || limit <= 0) {
      setRemaining(null);
      return;
    }
    const startedMs = new Date(startedAt).getTime();
    const tick = () => {
      const serverNow = Date.now() + offsetRef.current;
      setRemaining(Math.max(0, Math.ceil((startedMs + limit * 1000 - serverNow) / 1000)));
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [activityId, startedAt, limit]);

  return remaining;
}

function AdminGuard({ children }: { children: React.ReactNode }) {
  const token = getAdminToken();

  useEffect(() => {
    if (!token) navigate("/admin");
  }, [token]);

  if (!token) return null;
  return <>{children}</>;
}

function Header({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <header className="app-header">
      <button className="brand" onClick={() => navigate("/")}>
        Slihoot
      </button>
      <h1>{title}</h1>
      <div className="header-actions">{actions}</div>
    </header>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner">{message}</div>;
}

function correctOptionId(correctAnswer: unknown) {
  if (typeof correctAnswer !== "object" || correctAnswer === null) return "";
  return String((correctAnswer as { optionId?: unknown }).optionId ?? "");
}

function correctAnswerText(correctAnswer: unknown) {
  if (typeof correctAnswer !== "object" || correctAnswer === null) return "";
  return String((correctAnswer as { text?: unknown }).text ?? "");
}

function draftOption(label = ""): ActivityOption {
  return {
    id: crypto.randomUUID(),
    label
  };
}

function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: { password }
      });
      setAdminToken(data.token);
      navigate("/admin/dashboard");
    } catch (error) {
      setError(error instanceof Error ? error.message : "登入失敗");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page narrow">
      <Header title="主持人登入" />
      <form className="panel form-stack" onSubmit={submit}>
        <ErrorBanner message={error} />
        <label>
          管理密碼
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="輸入 ADMIN_PASSWORD"
          />
        </label>
        <button disabled={loading}>{loading ? "登入中..." : "登入"}</button>
      </form>
    </main>
  );
}

function JoinPage() {
  const [joinCode, setJoinCode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get("joinCode") ?? "").toUpperCase().slice(0, 8);
  });
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const savedSession = getParticipantSession();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        liveSession: LiveSessionRecord;
        participantToken: string;
      }>("/api/live-sessions/join", {
        method: "POST",
        body: { joinCode, nickname }
      });
      saveParticipantSession(data.liveSession.id, data.participantToken);
      navigate(`/live/${data.liveSession.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "加入失敗");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page narrow">
      <Header
        title="加入活動"
        actions={<button onClick={() => navigate("/admin")}>主持人</button>}
      />
      <section className="panel form-stack">
        <ErrorBanner message={error} />
        {savedSession.liveId && savedSession.participantToken ? (
          <button className="secondary" onClick={() => navigate(`/live/${savedSession.liveId}`)}>
            回到上一場活動
          </button>
        ) : null}
        <form className="form-stack" onSubmit={submit}>
          <label>
            活動代碼
            <input
              autoFocus={!joinCode}
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="例如 A8K2QW"
              maxLength={8}
            />
          </label>
          <label>
            暱稱
            <input
              autoFocus={Boolean(joinCode)}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="你的名字"
              maxLength={80}
            />
          </label>
          <button disabled={loading}>{loading ? "加入中..." : "加入活動"}</button>
        </form>
      </section>
    </main>
  );
}

function DashboardPage() {
  const token = getAdminToken();
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setEvents(await api<EventListItem[]>("/api/events", { adminToken: token }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "讀取活動失敗");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function createNew(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    try {
      const newEvent = await api<EventDetail>("/api/events", {
        method: "POST",
        adminToken: token,
        body: { title, description: "" }
      });
      setTitle("");
      navigate(`/admin/event/${newEvent.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "建立失敗");
    }
  }

  async function start(eventId: string) {
    if (!token) return;
    try {
      const liveSession = await api<LiveSessionRecord>(`/api/events/${eventId}/live-sessions`, {
        method: "POST",
        adminToken: token
      });
      navigate(`/admin/live/${liveSession.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "啟動失敗");
    }
  }

  async function remove(eventId: string) {
    if (!token || !confirm("刪除此活動？")) return;
    await api(`/api/events/${eventId}`, { method: "DELETE", adminToken: token });
    await load();
  }

  async function endLive(liveId: string) {
    if (!token || !confirm("結束這場 live session？")) return;
    try {
      await api(`/api/live-sessions/${liveId}/end`, {
        method: "POST",
        adminToken: token
      });
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "結束活動失敗");
    }
  }

  return (
    <AdminGuard>
      <main className="page">
        <Header
          title="活動管理"
          actions={
            <>
              <button
                className="secondary"
                onClick={() => {
                  clearAdminToken();
                  navigate("/admin");
                }}
              >
                登出
              </button>
            </>
          }
        />
        <section className="panel">
          <form className="inline-form" onSubmit={createNew}>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="新活動標題"
            />
            <button>建立活動</button>
          </form>
        </section>
        <ErrorBanner message={error} />
        {loading ? <p className="muted">讀取中...</p> : null}
        <section className="grid-list">
          {events.map((event) => (
            <article className="item-card" key={event.id}>
              <div>
                <h2>{event.title}</h2>
                <p>{event.description || "尚未填寫描述"}</p>
                <small>{event.activityCount} 題</small>
                {event.activeLiveSession ? (
                  <div className="live-chip">
                    <strong>進行中</strong>
                    <span>代碼 {event.activeLiveSession.joinCode}</span>
                    <span>{event.activeLiveSession.participantCount} 人</span>
                  </div>
                ) : null}
              </div>
              <div className="button-row">
                <button onClick={() => navigate(`/admin/event/${event.id}`)}>編輯</button>
                {event.activeLiveSession ? (
                  <>
                    <button onClick={() => navigate(`/admin/live/${event.activeLiveSession!.id}`)}>
                      回主持
                    </button>
                    <button className="danger" onClick={() => endLive(event.activeLiveSession!.id)}>
                      結束
                    </button>
                  </>
                ) : (
                  <button onClick={() => start(event.id)}>啟動</button>
                )}
                <button className="danger" onClick={() => remove(event.id)}>
                  刪除
                </button>
              </div>
            </article>
          ))}
        </section>
      </main>
    </AdminGuard>
  );
}

function createDefaultActivityDraft(): ActivityDraft {
  const firstOption = draftOption("選項 A");
  const secondOption = draftOption("選項 B");
  return {
    type: "multiple_choice",
    title: "",
    description: "",
    explanation: "",
    timeLimitSeconds: 30,
    options: [firstOption, secondOption],
    correctOptionId: "",
    correctText: ""
  };
}

function optionsForType(type: ActivityType, currentOptions: ActivityOption[]) {
  if (type === "short_answer" || type === "word_cloud") return [];
  if (type === "true_false") {
    return [
      { id: "true", label: "是" },
      { id: "false", label: "否" }
    ];
  }
  return currentOptions.length ? currentOptions : [draftOption("選項 A"), draftOption("選項 B")];
}

function EventEditorPage({ eventId }: { eventId: string }) {
  const token = getAdminToken();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [draft, setDraft] = useState<ActivityDraft>(() => createDefaultActivityDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const activityListRef = useRef<HTMLElement | null>(null);
  const activityListFlipRef = useRef<Map<string, DOMRect> | null>(null);
  const activityListFlipPendingRef = useRef(false);

  const recordActivityListFlip = useCallback(() => {
    const container = activityListRef.current;
    if (!container) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const rects = new Map<string, DOMRect>();
    container.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((element) => {
      const id = element.dataset.flipId;
      if (!id) return;
      rects.set(id, element.getBoundingClientRect());
    });

    activityListFlipRef.current = rects;
    activityListFlipPendingRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (!activityListFlipPendingRef.current) return;
    activityListFlipPendingRef.current = false;

    const container = activityListRef.current;
    const firstRects = activityListFlipRef.current;
    activityListFlipRef.current = null;
    if (!container || !firstRects) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-flip-id]"));
    for (const element of elements) {
      const id = element.dataset.flipId;
      if (!id) continue;
      const first = firstRects.get(id);
      if (!first) continue;

      const last = element.getBoundingClientRect();
      const deltaX = first.left - last.left;
      const deltaY = first.top - last.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const animation = element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" }
        ],
        {
          duration: 200,
          easing: "cubic-bezier(0.2, 0.0, 0.2, 1)"
        }
      );
      animation.onfinish = () => animation.cancel();
    }
  }, [event?.activities]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setEvent(await api<EventDetail>(`/api/events/${eventId}`, { adminToken: token }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "讀取活動失敗");
    }
  }, [eventId, token]);

  useEffect(() => {
    load();
  }, [load]);

  function editActivity(activity: ActivityRecord) {
    setEditingId(activity.id);
    setDraft({
      type: activity.type,
      title: activity.title,
      description: activity.description,
      explanation: activity.explanation,
      timeLimitSeconds: activity.timeLimitSeconds,
      options: activity.options,
      correctOptionId: correctOptionId(activity.correctAnswer),
      correctText: correctAnswerText(activity.correctAnswer)
    });
  }

  function payloadFromDraft() {
    return {
      type: draft.type,
      title: draft.title,
      description: draft.description,
      explanation: draft.explanation,
      timeLimitSeconds: draft.timeLimitSeconds,
      options: draft.options
        .map((option) => ({ ...option, label: option.label.trim() }))
        .filter((option) => option.label),
      correctAnswer:
        draft.type === "short_answer"
          ? draft.correctText.trim()
            ? { text: draft.correctText.trim() }
            : null
          : draft.correctOptionId
            ? { optionId: draft.correctOptionId }
            : null
    };
  }

  async function saveEvent(eventForm: React.FormEvent) {
    eventForm.preventDefault();
    if (!token || !event) return;
    try {
      const updated = await api<EventDetail>(`/api/events/${event.id}`, {
        method: "PUT",
        adminToken: token,
        body: {
          title: event.title,
          description: event.description
        }
      });
      setEvent(updated);
      navigate("/admin/dashboard");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to save event.");
    }
  }

  async function saveActivity(activityForm: React.FormEvent) {
    activityForm.preventDefault();
    if (!token || !event) return;
    try {
      if (editingId) {
        await api(`/api/activities/${editingId}`, {
          method: "PUT",
          adminToken: token,
          body: payloadFromDraft()
        });
      } else {
        await api(`/api/events/${event.id}/activities`, {
          method: "POST",
          adminToken: token,
          body: payloadFromDraft()
        });
      }
      setError(null);
      setDraft(createDefaultActivityDraft());
      setEditingId(null);
      await load();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "儲存題目失敗");
    }
  }

  async function removeActivity(activityId: string) {
    if (!token || !confirm("刪除此題？")) return;
    await api(`/api/activities/${activityId}`, { method: "DELETE", adminToken: token });
    await load();
  }

  async function moveActivity(activityId: string, direction: -1 | 1) {
    if (!token || !event || reordering) return;
    const activities = [...event.activities];
    const index = activities.findIndex((activity) => activity.id === activityId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= activities.length) return;
    [activities[index], activities[nextIndex]] = [activities[nextIndex], activities[index]];

    recordActivityListFlip();
    setEvent({ ...event, activities });

    setReordering(true);
    try {
      const reordered = await api<ActivityRecord[]>(`/api/events/${event.id}/activities/reorder`, {
        method: "PUT",
        adminToken: token,
        body: { activityIds: activities.map((activity) => activity.id) }
      });
      setEvent((current) => (current ? { ...current, activities: reordered } : current));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to reorder activity.");
      setEvent(event);
    } finally {
      setReordering(false);
    }
  }

  if (!event) {
    return (
      <AdminGuard>
        <main className="page">
          <Header title="活動編輯" />
          <p className="muted">讀取中...</p>
        </main>
      </AdminGuard>
    );
  }

  return (
    <AdminGuard>
      <main className="page">
        <Header
          title="活動編輯"
          actions={<button onClick={() => navigate("/admin/dashboard")}>回列表</button>}
        />
        <ErrorBanner message={error} />
        <div className="two-column">
          <section className="panel form-stack">
            <form className="form-stack" onSubmit={saveEvent}>
              <label>
                活動標題
                <input
                  value={event.title}
                  onChange={(change) => setEvent({ ...event, title: change.target.value })}
                />
              </label>
              <label>
                活動描述
                <textarea
                  value={event.description}
                  onChange={(change) => setEvent({ ...event, description: change.target.value })}
                />
              </label>
              <button>儲存活動</button>
            </form>
          </section>

          <section className="panel form-stack">
            <h2>{editingId ? "編輯題目" : "新增題目"}</h2>
            <form className="form-stack" onSubmit={saveActivity}>
              <label>
                題型
                <select
                  value={draft.type}
                  onChange={(change) => {
                    const nextType = change.target.value as ActivityType;
                    const nextOptions = optionsForType(nextType, draft.options);
                    setDraft({
                      ...draft,
                      type: nextType,
                      options: nextOptions,
                      correctOptionId: nextOptions.some(
                        (option) => option.id === draft.correctOptionId
                      )
                        ? draft.correctOptionId
                        : ""
                    });
                  }}
                >
                  <option value="multiple_choice">選擇題</option>
                  <option value="true_false">是非題</option>
                  <option value="short_answer">簡答題</option>
                  <option value="word_cloud">文字雲</option>
                </select>
              </label>
              <label>
                題目
                <input
                  value={draft.title}
                  onChange={(change) => setDraft({ ...draft, title: change.target.value })}
                />
              </label>
              <label>
                補充說明
                <textarea
                  value={draft.description}
                  onChange={(change) => setDraft({ ...draft, description: change.target.value })}
                />
              </label>
              <label>
                詳解
                <textarea
                  value={draft.explanation}
                  onChange={(change) => setDraft({ ...draft, explanation: change.target.value })}
                  placeholder="時間到後向參與者顯示的解析"
                />
              </label>
              <label>
                作答秒數（0 表示不限時）
                <input
                  type="number"
                  min={0}
                  max={3600}
                  value={draft.timeLimitSeconds}
                  onChange={(change) =>
                    setDraft({
                      ...draft,
                      timeLimitSeconds: Math.max(0, Math.min(3600, Number(change.target.value) || 0))
                    })
                  }
                />
              </label>
              {draft.type === "multiple_choice" || draft.type === "true_false" ? (
                <div className="form-stack">
                  <span className="field-label">選項與正確答案</span>
                  <div className="option-editor">
                    {draft.options.map((option, index) => (
                      <div className="option-edit-row" key={option.id}>
                        <input
                          type="radio"
                          name="correct-answer"
                          checked={draft.correctOptionId === option.id}
                          onChange={() => setDraft({ ...draft, correctOptionId: option.id })}
                          title="設為正確答案"
                        />
                        <input
                          value={option.label}
                          disabled={draft.type === "true_false"}
                          onChange={(change) => {
                            const nextOptions = draft.options.map((candidate) =>
                              candidate.id === option.id
                                ? { ...candidate, label: change.target.value }
                                : candidate
                            );
                            setDraft({ ...draft, options: nextOptions });
                          }}
                          placeholder={`選項 ${index + 1}`}
                        />
                        {draft.type === "multiple_choice" ? (
                          <button
                            className="secondary"
                            type="button"
                            disabled={draft.options.length <= 2}
                            onClick={() => {
                              const nextOptions = draft.options.filter(
                                (candidate) => candidate.id !== option.id
                              );
                              setDraft({
                                ...draft,
                                options: nextOptions,
                                correctOptionId:
                                  draft.correctOptionId === option.id ? "" : draft.correctOptionId
                              });
                            }}
                          >
                            移除
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {draft.type === "multiple_choice" ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={draft.options.length >= 6}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          options: [...draft.options, draftOption(`選項 ${draft.options.length + 1}`)]
                        })
                      }
                    >
                      新增選項
                    </button>
                  ) : null}
                </div>
              ) : null}
              {draft.type === "short_answer" ? (
                <label>
                  正確答案（需與作答完全相同）
                  <input
                    value={draft.correctText}
                    onChange={(change) => setDraft({ ...draft, correctText: change.target.value })}
                    placeholder="輸入標準答案"
                  />
                </label>
              ) : null}
              <div className="button-row">
                <button>{editingId ? "更新題目" : "新增題目"}</button>
                {editingId ? (
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setDraft(createDefaultActivityDraft());
                    }}
                  >
                    取消
                  </button>
                ) : null}
              </div>
            </form>
          </section>
        </div>

        <section className="activity-list" ref={activityListRef}>
          {event.activities.map((activity, index) => (
            <article className="item-card" key={activity.id} data-flip-id={activity.id}>
              <div>
                <small>
                  #{index + 1} {activity.type}
                  {activity.timeLimitSeconds > 0 ? ` · ${activity.timeLimitSeconds} 秒` : " · 不限時"}
                </small>
                <h2>{activity.title}</h2>
                <p>{activity.description}</p>
                {activity.explanation ? <p className="muted">詳解：{activity.explanation}</p> : null}
                {activity.type === "short_answer" && correctAnswerText(activity.correctAnswer) ? (
                  <p className="muted">正解：{correctAnswerText(activity.correctAnswer)}</p>
                ) : null}
                {activity.options.length ? (
                  <div className="option-pills">
                    {activity.options.map((option) => (
                      <span key={option.id}>
                        {option.label}
                        {correctOptionId(activity.correctAnswer) === option.id ? " (正解)" : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="button-row">
                <button
                  disabled={reordering || index === 0}
                  onClick={() => moveActivity(activity.id, -1)}
                >
                  上移
                </button>
                <button
                  disabled={reordering || index === event.activities.length - 1}
                  onClick={() => moveActivity(activity.id, 1)}
                >
                  下移
                </button>
                <button onClick={() => editActivity(activity)}>編輯</button>
                <button className="danger" onClick={() => removeActivity(activity.id)}>
                  刪除
                </button>
              </div>
            </article>
          ))}
        </section>
      </main>
    </AdminGuard>
  );
}

function SummaryView({ summary }: { summary: ResponseSummary | null }) {
  if (!summary) return <p className="muted">尚未開放或沒有結果。</p>;

  if (summary.type === "short_answer") {
    return (
      <div className="answer-list">
        {summary.correctAnswerText ? (
          <p className="muted">
            正確答案：<strong>{summary.correctAnswerText}</strong>
            {typeof summary.correctCount === "number"
              ? `（答對 ${summary.correctCount} / ${summary.total}）`
              : null}
          </p>
        ) : null}
        {summary.responses?.length ? (
          summary.responses.map((response, index) => (
            <div className="answer-item" key={`${response.receivedAt}-${index}`}>
              <strong>{response.participantName ?? "匿名"}</strong>
              <p>
                {response.text}
                {response.isCorrect === true ? (
                  <em className="verdict correct"> 正確</em>
                ) : response.isCorrect === false ? (
                  <em className="verdict wrong"> 錯誤</em>
                ) : null}
              </p>
            </div>
          ))
        ) : (
          <p className="muted">
            {summary.total ? `已有 ${summary.total} 則回答。` : "尚無回答。"}
          </p>
        )}
      </div>
    );
  }

  if (summary.type === "word_cloud") {
    return (
      <>
        {summary.words?.length ? <WordCloudView words={summary.words} /> : (
          <p className="muted">尚未收到文字。</p>
        )}
      </>
    );
  }

  return (
    <div className="result-stack">
      <div className="result-bars">
        {summary.options?.map((option) => (
          <div className="result-row" key={option.id}>
            <div className="result-label">
              <span>
                {option.label}
                {option.isCorrect ? <em>正解</em> : null}
              </span>
              <strong>{option.count}</strong>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${option.percent}%` }} />
            </div>
            <small>{option.percent}%</small>
          </div>
        ))}
        <p className="muted">總回答數: {summary.total}</p>
      </div>
      {summary.responses?.length ? (
        <div className="response-table">
          <div className="response-row heading">
            <span>參與者</span>
            <span>答案</span>
            <span>判定</span>
          </div>
          {summary.responses.map((response, index) => (
            <div className="response-row" key={`${response.receivedAt}-${index}`}>
              <span>{response.participantName ?? "匿名"}</span>
              <span>{response.answerLabel ?? response.text ?? "-"}</span>
              <span>
                {response.isCorrect === true
                  ? "正確"
                  : response.isCorrect === false
                    ? "錯誤"
                    : "-"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChatPanel({
  role,
  messages,
  onSend,
  onModerate
}: {
  role: "admin" | "participant";
  messages: LiveMessageRecord[];
  onSend?: (content: string) => void;
  onModerate?: (messageId: string, action: string) => void;
}) {
  const [content, setContent] = useState("");
  const visibleMessages = messages.filter((message) => message.status !== "deleted");

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    onSend?.(content);
    setContent("");
  }

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <h2>Q&A</h2>
        <small>{visibleMessages.length} 則</small>
      </div>
      <div className="messages">
        {visibleMessages.map((message) => (
          <article className={`message ${message.status}`} key={message.id}>
            <div className="message-meta">
              <strong>{message.participantName}</strong>
              {message.pinned ? <span>釘選</span> : null}
              {role === "admin" && message.status !== "visible" ? <span>{message.status}</span> : null}
            </div>
            <p>{message.content}</p>
            {role === "admin" ? (
              <div className="button-row compact">
                {message.status === "visible" ? (
                  <button onClick={() => onModerate?.(message.id, "hide")}>隱藏</button>
                ) : message.status === "hidden" ? (
                  <button onClick={() => onModerate?.(message.id, "show")}>顯示</button>
                ) : null}
                <button onClick={() => onModerate?.(message.id, message.pinned ? "unpin" : "pin")}>
                  {message.pinned ? "取消釘選" : "釘選"}
                </button>
                <button className="danger" onClick={() => onModerate?.(message.id, "delete")}>
                  刪除
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {role === "participant" ? (
        <form className="chat-form" onSubmit={sendMessage}>
          <input
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="輸入問題"
            maxLength={200}
          />
          <button>送出</button>
        </form>
      ) : null}
    </aside>
  );
}

function mergeMessage(messages: LiveMessageRecord[], message: LiveMessageRecord) {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

type WordCloudWord = NonNullable<ResponseSummary["words"]>[number];

function hashText(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function measureWordWidth(text: string, fontSize: number) {
  const widthUnits = Array.from(text).reduce((total, char) => {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) return total + 1;
    if (/[A-Z0-9]/.test(char)) return total + 0.68;
    return total + 0.56;
  }, 0);
  return Math.max(fontSize, widthUnits * fontSize);
}

function intersects(
  box: { left: number; right: number; top: number; bottom: number },
  boxes: Array<{ left: number; right: number; top: number; bottom: number }>
) {
  return boxes.some(
    (placed) =>
      box.left < placed.right &&
      box.right > placed.left &&
      box.top < placed.bottom &&
      box.bottom > placed.top
  );
}

function layoutWordCloud(words: WordCloudWord[]) {
  const width = 800;
  const height = 420;
  const centerX = width / 2;
  const centerY = height / 2;
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];

  return [...words]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, 60)
    .flatMap((word) => {
      const fontSize = Math.round(18 + Math.pow(word.weight, 0.72) * 54);
      const wordWidth = measureWordWidth(word.text, fontSize);
      const wordHeight = fontSize * 1.05;
      const seed = hashText(word.text);
      const angleOffset = (seed % 628) / 100;

      for (let attempt = 0; attempt < 650; attempt += 1) {
        const angle = angleOffset + attempt * 0.38;
        const radius = 2.8 * angle;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius * 0.62;
        const box = {
          left: x - wordWidth / 2 - 7,
          right: x + wordWidth / 2 + 7,
          top: y - wordHeight / 2 - 5,
          bottom: y + wordHeight / 2 + 5
        };

        if (box.left < 14 || box.right > width - 14 || box.top < 14 || box.bottom > height - 14) {
          continue;
        }

        if (intersects(box, boxes)) continue;

        boxes.push(box);
        return [
          {
            ...word,
            x,
            y,
            fontSize,
            colorIndex: seed % 6
          }
        ];
      }

      return [];
    });
}

function WordCloudView({ words }: { words: WordCloudWord[] }) {
  const placedWords = useMemo(() => layoutWordCloud(words), [words]);
  const colors = ["#176b87", "#1b7f55", "#b45f06", "#7a3e9d", "#9f2d55", "#3856a6"];

  return (
    <svg className="word-cloud" viewBox="0 0 800 420" role="img" aria-label="文字雲結果">
      <rect width="800" height="420" rx="8" />
      {placedWords.map((word) => (
        <text
          className="word-cloud-text"
          key={word.text}
          x={word.x}
          y={word.y}
          fill={colors[word.colorIndex]}
          fontSize={word.fontSize}
        >
          <title>{`${word.text}: ${word.count} 票，${word.percent}%`}</title>
          {word.text}
        </text>
      ))}
    </svg>
  );
}

function AdminLivePage({ liveId }: { liveId: string }) {
  const token = getAdminToken();
  const [state, setState] = useState<LiveState | null>(null);
  const [messages, setMessages] = useState<LiveMessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const copyTimerRef = useRef<number | null>(null);
  const qrDialogRef = useRef<HTMLDialogElement | null>(null);
  const [tryTunnel, setTryTunnel] = useState<TryCloudflareTunnelState | null>(null);
  const tunnelPollRef = useRef<number | null>(null);
  const localPortForTunnel = useMemo(() => {
    const port = window.location.port ? Number(window.location.port) : NaN;
    if (Number.isFinite(port) && port > 0) return port;
    return window.location.protocol === "https:" ? 443 : 80;
  }, []);
  const autoTunnelAttemptRef = useRef<string | null>(null);

  const joinCode = state?.liveSession.joinCode ?? "";
  // On a real public domain (e.g. https://slihoot.me) the page's own origin is
  // already shareable, so the join link should just use it. The Cloudflare
  // tunnel is only needed for local dev where the origin is localhost.
  const isLocalhostOrigin = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(
    window.location.hostname
  );
  const effectiveBaseUrl = useMemo(() => {
    const tunnelUrl = tryTunnel?.status === "running" ? tryTunnel.publicUrl : null;
    return tunnelUrl ?? window.location.origin;
  }, [tryTunnel?.publicUrl, tryTunnel?.status]);
  const joinUrl = useMemo(() => {
    if (!joinCode) return "";
    if (!effectiveBaseUrl) return "";
    const url = new URL("/", effectiveBaseUrl);
    url.searchParams.set("joinCode", joinCode);
    return url.toString();
  }, [effectiveBaseUrl, joinCode]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const loadTryTunnelState = useCallback(async () => {
    if (!token) return null;
    const loaded = await api<TryCloudflareTunnelState>("/api/tunnel/trycloudflare", {
      adminToken: token
    });
    setTryTunnel(loaded);
    return loaded;
  }, [token]);

  useEffect(() => {
    if (!token) return;
    loadTryTunnelState().catch(() => {});
  }, [loadTryTunnelState, token]);

  useEffect(() => {
    if (!token) return;
    if (tryTunnel?.status !== "starting") return;

    if (tunnelPollRef.current) window.clearInterval(tunnelPollRef.current);
    const timer = window.setInterval(() => {
      loadTryTunnelState().catch(() => {});
    }, 800);
    tunnelPollRef.current = timer;

    return () => {
      window.clearInterval(timer);
      if (tunnelPollRef.current === timer) tunnelPollRef.current = null;
    };
  }, [loadTryTunnelState, token, tryTunnel?.status]);

  const startTryTunnel = useCallback(async () => {
    if (!token) return;
    try {
      const started = await api<TryCloudflareTunnelState>("/api/tunnel/trycloudflare/start", {
        method: "POST",
        adminToken: token,
        body: { port: localPortForTunnel }
      });
      setTryTunnel(started);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to start tunnel.");
    }
  }, [localPortForTunnel, token]);

  useEffect(() => {
    if (!token) return;
    if (!joinCode) return;
    // Public/LAN origin is already shareable — only auto-start a tunnel on localhost.
    if (!isLocalhostOrigin) return;
    if (tryTunnel?.status === "running" || tryTunnel?.status === "starting") return;
    if (autoTunnelAttemptRef.current === joinCode) return;

    autoTunnelAttemptRef.current = joinCode;
    startTryTunnel();
  }, [isLocalhostOrigin, joinCode, startTryTunnel, token, tryTunnel?.status]);

  const copyJoinUrl = useCallback(async () => {
    if (!joinUrl) return;
    const ok = await copyToClipboard(joinUrl);
    setCopyStatus(ok ? "copied" : "error");
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyStatus("idle"), 1800);
  }, [joinUrl]);

  const openJoinQr = useCallback(() => {
    const dialog = qrDialogRef.current;
    if (!dialog) return;
    if (isLocalhostOrigin && tryTunnel?.status !== "running" && tryTunnel?.status !== "starting") {
      startTryTunnel();
    }
    if (dialog.open) return;
    dialog.showModal();
  }, [isLocalhostOrigin, startTryTunnel, tryTunnel?.status]);

  const load = useCallback(async () => {
    if (!token) return;
    const [liveState, loadedMessages] = await Promise.all([
      api<LiveState>(`/api/live-sessions/${liveId}`, { adminToken: token }),
      api<LiveMessageRecord[]>(`/api/live-sessions/${liveId}/messages?includeHidden=true`, {
        adminToken: token
      })
    ]);
    setState(liveState);
    setMessages(loadedMessages);
  }, [liveId, token]);

  useEffect(() => {
    load().catch((error) => setError(error instanceof Error ? error.message : "讀取失敗"));
  }, [load]);

  const handleMessage = useCallback((message: SocketMessage) => {
    if (message.type === "state_change") {
      setState(message.payload as LiveState);
    }
    if (message.type === "participant_joined") {
      setState((current) =>
        current
          ? {
              ...current,
              participantCount: (message.payload as any).participantCount
            }
          : current
      );
    }
    if (message.type === "response_summary_update") {
      setState((current) =>
        current
          ? {
              ...current,
              responseSummary: (message.payload as any).responseSummary
            }
          : current
      );
    }
    if (message.type === "new_message") {
      setMessages((current) => mergeMessage(current, (message.payload as any).message));
    }
    if (message.type === "message_updated") {
      const updated = (message.payload as any).message as LiveMessageRecord | undefined;
      if (updated?.status === "deleted") {
        setMessages((current) => current.filter((candidate) => candidate.id !== updated.id));
      } else if (updated) {
        setMessages((current) => mergeMessage(current, updated));
      }
    }
  }, []);

  const socket = useLiveSocket({
    liveId,
    role: "admin",
    token,
    onMessage: handleMessage,
    onError: setError
  });

  const remaining = useServerCountdown(state);
  const activities = state?.activities ?? [];
  const currentIndex = activities.findIndex((activity) => activity.id === state?.currentActivity?.id);
  const previousActivity = activities[currentIndex - 1];
  const nextActivity = activities[currentIndex + 1];
  const isWordCloudActivity = state?.currentActivity?.type === "word_cloud";
  const hasCurrentActivity = Boolean(state?.currentActivity);
  const activityOpen = Boolean(state?.activityOpen);
  const answerClosed = Boolean(state?.answerClosed);

  async function endLive() {
    if (!token || !confirm("結束這場活動？")) return;
    const liveSession = await api<LiveSessionRecord>(`/api/live-sessions/${liveId}/end`, {
      method: "POST",
      adminToken: token
    });
    setState((current) => (current ? { ...current, liveSession } : current));
  }

  return (
    <AdminGuard>
      <main className="page live-layout">
        <Header
          title="主持畫面"
          actions={<button onClick={() => navigate("/admin/dashboard")}>回列表</button>}
        />
        <ErrorBanner message={error} />
        <dialog
          ref={qrDialogRef}
          className="qr-dialog"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              event.currentTarget.close();
            }
          }}
        >
          <form method="dialog" className="form-stack">
            <div className="share-dialog-header">
              <h2>分享連結</h2>
              <button
                type="button"
                className="icon-button close-button"
                aria-label="關閉"
                onClick={() => qrDialogRef.current?.close()}
              >
                ×
              </button>
            </div>
            {tryTunnel?.status === "starting" ? (
              <p className="muted">Cloudflare 分享連結產生中...</p>
            ) : null}
            {tryTunnel?.lastError ? <div className="error-banner">{tryTunnel.lastError}</div> : null}
            {joinUrl ? (
              <div className="qr-preview">
                <QRCodeSVG value={joinUrl} size={260} marginSize={4} />
              </div>
            ) : (
              <p className="muted">尚未取得 Cloudflare 分享連結。</p>
            )}
            <label>
              分享連結
              <input readOnly value={joinUrl} />
            </label>
            <div className="button-row">
              <button type="button" disabled={!joinUrl} onClick={copyJoinUrl}>
                {copyStatus === "copied" ? "已複製" : "複製連結"}
              </button>
            </div>
          </form>
        </dialog>
        <section className="live-main panel">
          <div className="status-row">
            <span className={socket.connected ? "status online" : "status"} />
            <strong>代碼 {joinCode || "..."}</strong>
            <button className="secondary" disabled={!joinCode} onClick={openJoinQr}>
              分享連結
            </button>
            <span>{state?.participantCount ?? 0} 人加入</span>
            <span>{state?.liveSession.status}</span>
          </div>
          <div className="question-block">
            <small>
              {currentIndex + 1 || 0} / {activities.length}
            </small>
            <h2>{state?.currentActivity?.title ?? "尚無題目"}</h2>
            <p>{state?.currentActivity?.description}</p>
            {answerClosed ? (
              <div className="countdown ended">已結束作答（已公布答案）</div>
            ) : remaining !== null ? (
              <div className={`countdown${remaining === 0 ? " ended" : ""}`}>
                {remaining === 0 ? "時間到（已公布答案）" : `剩餘 ${remaining} 秒`}
              </div>
            ) : hasCurrentActivity && !activityOpen ? (
              <div className="countdown">尚未開始作答，參與者看不到題目</div>
            ) : null}
          </div>
          <div className="button-row">
            {hasCurrentActivity && !activityOpen ? (
              <button onClick={() => socket.send("start_activity", {})}>開始答題</button>
            ) : null}
            <button
              disabled={!previousActivity}
              onClick={() => socket.send("change_activity", { activityId: previousActivity.id })}
            >
              上一題
            </button>
            <button
              disabled={!nextActivity}
              onClick={() => socket.send("change_activity", { activityId: nextActivity.id })}
            >
              下一題
            </button>
            <button
              hidden={isWordCloudActivity}
              disabled={remaining !== null && remaining > 0}
              title={
                remaining !== null && remaining > 0 ? "倒數結束後才能公布結果" : undefined
              }
              onClick={() =>
                socket.send("set_results_visibility", {
                  showResults: !state?.liveSession.showResults
                })
              }
            >
              {state?.liveSession.showResults ? "隱藏結果" : "顯示結果"}
            </button>
            <button
              hidden={isWordCloudActivity}
              onClick={() =>
                socket.send("set_participant_name_visibility", {
                  showParticipantNames: !state?.liveSession.showParticipantNames
                })
              }
            >
              {state?.liveSession.showParticipantNames ? "匿名明細" : "記名明細"}
            </button>
            <button className="danger" onClick={endLive}>
              結束
            </button>
          </div>
          <section className="results-panel">
            <h2>即時結果</h2>
            <SummaryView summary={state?.responseSummary ?? null} />
          </section>
        </section>
        <ChatPanel
          role="admin"
          messages={messages}
          onModerate={(messageId, action) =>
            socket.send("moderate_message", { messageId, action })
          }
        />
      </main>
    </AdminGuard>
  );
}

function AnswerForm({
  activity,
  disabled,
  revealed,
  submittedOptionId = "",
  submittedText = "",
  onSubmit
}: {
  activity: ActivityRecord;
  disabled: boolean;
  revealed: boolean;
  submittedOptionId?: string;
  submittedText?: string;
  onSubmit: (answer: unknown) => boolean | void;
}) {
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const correctId = correctOptionId(activity.correctAnswer);

  useEffect(() => {
    setSelected(submittedOptionId);
    setText(submittedText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  if (activity.type === "word_cloud") {
    return (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const sent = onSubmit({ text });
          if (sent !== false) setText("");
        }}
      >
        <input
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          placeholder="輸入一個詞或短句"
          maxLength={80}
        />
        <button disabled={disabled || !text.trim()}>{disabled ? "已送出" : "送出文字"}</button>
      </form>
    );
  }

  if (activity.type === "short_answer") {
    return (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ text });
        }}
      >
        <textarea
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          placeholder="輸入你的回答"
        />
        <button disabled={disabled || !text.trim()}>{disabled ? "已送出" : "送出答案"}</button>
        {revealed ? (
          <div className="answer-reveal">
            <p>
              正確答案：<strong>{correctAnswerText(activity.correctAnswer) || "—"}</strong>
            </p>
            {submittedText ? (
              <p
                className={
                  submittedText.trim() === correctAnswerText(activity.correctAnswer)
                    ? "verdict correct"
                    : "verdict wrong"
                }
              >
                你的答案：{submittedText}（
                {submittedText.trim() === correctAnswerText(activity.correctAnswer) ? "正確" : "錯誤"}）
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    );
  }

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ optionId: selected });
      }}
    >
      <div className="choice-list">
        {activity.options.map((option) => {
          const isCorrect = revealed && correctId === option.id;
          const isWrongPick =
            revealed && submittedOptionId === option.id && correctId !== option.id;
          return (
            <label
              className={`choice${isCorrect ? " correct" : isWrongPick ? " wrong" : ""}`}
              key={option.id}
            >
              <input
                type="radio"
                name={activity.id}
                checked={selected === option.id}
                disabled={disabled}
                onChange={() => setSelected(option.id)}
              />
              <span>
                {option.label}
                {isCorrect ? <em> 正解</em> : null}
                {isWrongPick ? <em> 你的選擇</em> : null}
              </span>
            </label>
          );
        })}
      </div>
      <button disabled={disabled || !selected}>{disabled ? "已送出" : "送出答案"}</button>
    </form>
  );
}

function ParticipantLivePage({ liveId }: { liveId: string }) {
  const savedSession = getParticipantSession();
  const participantToken = savedSession.liveId === liveId ? savedSession.participantToken : null;
  const [state, setState] = useState<LiveState | null>(null);
  const [messages, setMessages] = useState<LiveMessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localResponse, setLocalResponse] = useState<ResponseRecord | null>(null);

  useEffect(() => {
    if (!participantToken) {
      setError("找不到參與者憑證，請重新加入活動。");
      return;
    }
    api<LiveMessageRecord[]>(`/api/live-sessions/${liveId}/messages`, {
      participantToken
    })
      .then(setMessages)
      .catch((error) => setError(error instanceof Error ? error.message : "讀取訊息失敗"));
  }, [liveId, participantToken]);

  const handleMessage = useCallback((message: SocketMessage) => {
    if (message.type === "state_change") {
      const nextState = message.payload as LiveState;
      setState(nextState);
      setLocalResponse(nextState.myResponse ?? null);
    }
    if (message.type === "answer_recorded") {
      setLocalResponse((message.payload as any).response);
    }
    if (message.type === "response_summary_update") {
      setState((current) =>
        current
          ? {
              ...current,
              responseSummary: (message.payload as any).responseSummary
            }
          : current
      );
    }
    if (message.type === "new_message") {
      setMessages((current) => mergeMessage(current, (message.payload as any).message));
    }
    if (message.type === "message_updated") {
      const payload = message.payload as any;
      setMessages((current) =>
        current
          .map((candidate) =>
            candidate.id === payload.messageId
              ? { ...candidate, status: payload.status, pinned: payload.pinned }
              : candidate
          )
          .filter((candidate) => candidate.status === "visible")
      );
    }
  }, []);

  const socket = useLiveSocket({
    liveId,
    role: "participant",
    token: participantToken,
    onMessage: handleMessage,
    onError: setError
  });

  const currentActivity = state?.currentActivity ?? null;
  const answerLocked = Boolean(localResponse) && currentActivity?.type !== "word_cloud";
  const myAnswer = (localResponse?.answer ?? state?.myResponse?.answer) as
    | { optionId?: unknown; text?: unknown }
    | undefined;
  const submittedOptionId =
    myAnswer && typeof myAnswer === "object" ? String(myAnswer.optionId ?? "") : "";
  const submittedText =
    myAnswer && typeof myAnswer === "object" ? String(myAnswer.text ?? "") : "";
  const remaining = useServerCountdown(state);
  const revealed = Boolean(state?.answerRevealed);
  const closed = Boolean(state?.answerClosed);
  const timeUp = remaining === 0 || revealed;
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => Number(a.pinned !== b.pinned) * (a.pinned ? -1 : 1)),
    [messages]
  );

  if (!participantToken) {
    return (
      <main className="page narrow">
        <Header title="活動" />
        <ErrorBanner message={error} />
        <button onClick={() => navigate("/")}>重新加入</button>
      </main>
    );
  }

  return (
    <main className="page live-layout participant">
      <Header title={state?.event.title ?? "活動中"} actions={<button onClick={() => navigate("/")}>首頁</button>} />
      <ErrorBanner message={error} />
      <section className="live-main panel">
        <div className="status-row">
          <span className={socket.connected ? "status online" : "status"} />
          <span>你是 {state?.me?.nickname ?? "參與者"}</span>
          <span>{state?.liveSession.status ?? "連線中"}</span>
          <span>{state?.participantCount ?? 0} 人</span>
        </div>
        {currentActivity ? (
          <>
            <div className="question-block">
              <h2>{currentActivity.title}</h2>
              <p>{currentActivity.description}</p>
              {closed ? (
                <div className="countdown ended">已結束作答</div>
              ) : remaining !== null ? (
                <div className={`countdown${timeUp ? " ended" : ""}`}>
                  {timeUp ? "時間到" : `剩餘 ${remaining} 秒`}
                </div>
              ) : null}
            </div>
            <AnswerForm
              activity={currentActivity}
              disabled={
                closed ||
                state?.liveSession.status === "ended" ||
                (currentActivity.type === "word_cloud" ? timeUp : answerLocked || timeUp)
              }
              revealed={revealed}
              submittedOptionId={submittedOptionId}
              submittedText={submittedText}
              onSubmit={(answer) => {
                const sent = socket.send("submit_answer", {
                  activityId: currentActivity.id,
                  answer
                });
                if (sent && currentActivity.type !== "word_cloud") setLocalResponse({} as ResponseRecord);
                return sent;
              }}
            />
            {revealed && currentActivity.explanation ? (
              <section className="results-panel explanation-panel">
                <h2>詳解</h2>
                <p>{currentActivity.explanation}</p>
              </section>
            ) : null}
            {revealed || state?.liveSession.showResults ? (
              <section className="results-panel">
                <h2>結果</h2>
                <SummaryView summary={state?.responseSummary ?? null} />
              </section>
            ) : null}
          </>
        ) : state?.liveSession.currentActivityId ? (
          <p className="muted">主持人即將開始這一題，請稍候…</p>
        ) : (
          <p className="muted">主持人尚未準備題目。</p>
        )}
      </section>
      <ChatPanel
        role="participant"
        messages={sortedMessages}
        onSend={(content) => socket.send("send_message", { content })}
      />
    </main>
  );
}

export function App() {
  const path = usePath();

  if (path === "/admin") return <LoginPage />;
  if (path === "/admin/dashboard") return <DashboardPage />;

  const eventMatch = path.match(/^\/admin\/event\/([^/]+)$/);
  if (eventMatch) return <EventEditorPage eventId={eventMatch[1]} />;

  const adminLiveMatch = path.match(/^\/admin\/live\/([^/]+)$/);
  if (adminLiveMatch) return <AdminLivePage liveId={adminLiveMatch[1]} />;

  const liveMatch = path.match(/^\/live\/([^/]+)$/);
  if (liveMatch) return <ParticipantLivePage liveId={liveMatch[1]} />;

  if (path === "/logout") {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(PARTICIPANT_TOKEN_KEY);
    localStorage.removeItem(PARTICIPANT_LIVE_KEY);
    navigate("/");
    return null;
  }

  return <JoinPage />;
}
