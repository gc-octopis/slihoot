import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [joinCode, setJoinCode] = useState("");
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
              autoFocus
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="例如 A8K2QW"
              maxLength={8}
            />
          </label>
          <label>
            暱稱
            <input
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
    correctOptionId: ""
  };
}

function optionsForType(type: ActivityType, currentOptions: ActivityOption[]) {
  if (type === "short_answer") return [];
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
      correctOptionId: correctOptionId(activity.correctAnswer)
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
      correctAnswer: draft.correctOptionId ? { optionId: draft.correctOptionId } : null
    };
  }

  async function saveEvent(eventForm: React.FormEvent) {
    eventForm.preventDefault();
    if (!token || !event) return;
    const updated = await api<EventDetail>(`/api/events/${event.id}`, {
      method: "PUT",
      adminToken: token,
      body: {
        title: event.title,
        description: event.description
      }
    });
    setEvent(updated);
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
      setDraft(createDefaultActivityDraft());
      setEditingId(null);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "儲存題目失敗");
    }
  }

  async function removeActivity(activityId: string) {
    if (!token || !confirm("刪除此題？")) return;
    await api(`/api/activities/${activityId}`, { method: "DELETE", adminToken: token });
    await load();
  }

  async function moveActivity(activityId: string, direction: -1 | 1) {
    if (!token || !event) return;
    const activities = [...event.activities];
    const index = activities.findIndex((activity) => activity.id === activityId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= activities.length) return;
    [activities[index], activities[nextIndex]] = [activities[nextIndex], activities[index]];
    const reordered = await api<ActivityRecord[]>(`/api/events/${event.id}/activities/reorder`, {
      method: "PUT",
      adminToken: token,
      body: { activityIds: activities.map((activity) => activity.id) }
    });
    setEvent({ ...event, activities: reordered });
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
              {draft.type !== "short_answer" ? (
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

        <section className="activity-list">
          {event.activities.map((activity, index) => (
            <article className="item-card" key={activity.id}>
              <div>
                <small>
                  #{index + 1} {activity.type}
                  {activity.timeLimitSeconds > 0 ? ` · ${activity.timeLimitSeconds} 秒` : " · 不限時"}
                </small>
                <h2>{activity.title}</h2>
                <p>{activity.description}</p>
                {activity.explanation ? <p className="muted">詳解：{activity.explanation}</p> : null}
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
                <button onClick={() => moveActivity(activity.id, -1)}>上移</button>
                <button onClick={() => moveActivity(activity.id, 1)}>下移</button>
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
        {summary.responses?.length ? (
          summary.responses.map((response, index) => (
            <div className="answer-item" key={`${response.receivedAt}-${index}`}>
              <strong>{response.participantName ?? "匿名"}</strong>
              <p>{response.text}</p>
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

function AdminLivePage({ liveId }: { liveId: string }) {
  const token = getAdminToken();
  const [state, setState] = useState<LiveState | null>(null);
  const [messages, setMessages] = useState<LiveMessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        <section className="live-main panel">
          <div className="status-row">
            <span className={socket.connected ? "status online" : "status"} />
            <strong>代碼 {state?.liveSession.joinCode ?? "..."}</strong>
            <span>{state?.participantCount ?? 0} 人加入</span>
            <span>{state?.liveSession.status}</span>
          </div>
          <div className="question-block">
            <small>
              {currentIndex + 1 || 0} / {activities.length}
            </small>
            <h2>{state?.currentActivity?.title ?? "尚無題目"}</h2>
            <p>{state?.currentActivity?.description}</p>
            {remaining !== null ? (
              <div className={`countdown${remaining === 0 ? " ended" : ""}`}>
                {remaining === 0 ? "時間到（已公布答案）" : `剩餘 ${remaining} 秒`}
              </div>
            ) : null}
          </div>
          <div className="button-row">
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
              onClick={() =>
                socket.send("set_results_visibility", {
                  showResults: !state?.liveSession.showResults
                })
              }
            >
              {state?.liveSession.showResults ? "隱藏結果" : "顯示結果"}
            </button>
            <button
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
  onSubmit
}: {
  activity: ActivityRecord;
  disabled: boolean;
  revealed: boolean;
  onSubmit: (answer: unknown) => void;
}) {
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const correctId = correctOptionId(activity.correctAnswer);

  useEffect(() => {
    setSelected("");
    setText("");
  }, [activity.id]);

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
          return (
            <label
              className={`choice${isCorrect ? " correct" : ""}`}
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
  const answered = Boolean(localResponse);
  const remaining = useServerCountdown(state);
  const revealed = Boolean(state?.answerRevealed);
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
              {remaining !== null ? (
                <div className={`countdown${timeUp ? " ended" : ""}`}>
                  {timeUp ? "時間到" : `剩餘 ${remaining} 秒`}
                </div>
              ) : null}
            </div>
            <AnswerForm
              activity={currentActivity}
              disabled={answered || timeUp || state?.liveSession.status === "ended"}
              revealed={revealed}
              onSubmit={(answer) => {
                const sent = socket.send("submit_answer", {
                  activityId: currentActivity.id,
                  answer
                });
                if (sent) setLocalResponse({} as ResponseRecord);
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
