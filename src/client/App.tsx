import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { QRCodeSVG } from "qrcode.react";
import type {
  ActiveLiveSessionSummary,
  ActivityOption,
  ActivityRecord,
  ActivityType,
  EventPresentationRecord,
  EventRecord,
  LeaderboardEntry,
  LiveMessageRecord,
  LiveSessionRecord,
  LiveState,
  ResponseRecord,
  ResponseSummary,
  SocketMessage,
  TimelineItemRecord
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

import logo from '/logo.svg?url';
import logoSmall from '/logo_small.svg?url';

type EventListItem = EventRecord & {
  activityCount: number;
  activeLiveSession: ActiveLiveSessionSummary | null;
};
type EventDetail = EventRecord & {
  activities: ActivityRecord[];
  presentation: EventPresentationRecord | null;
  timeline: TimelineItemRecord[];
  alarms?: AlarmRecord[];
};
type AlarmRecord = {
  id: string;
  time: string; // HH:MM
  songFile: string;
};
type ActivityDraft = {
  type: ActivityType;
  title: string;
  description: string;
  explanation: string;
  hasDescription: boolean;
  hasExplanation: boolean;
  hasTimeLimit: boolean;
  allowRepeatAnswers: boolean;
  timeLimitSeconds: number;
  options: ActivityOption[];
  correctOptionId: string;
  correctText: string;
};

type PdfViewport = {
  width: number;
  height: number;
};

type PdfRenderTask = {
  promise: Promise<void>;
  cancel?: () => void;
};

type PdfPageProxy = {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): PdfRenderTask;
};

type PdfDocumentProxy = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
};

type PdfJsModule = {
  GlobalWorkerOptions: {
    workerSrc: string;
  };
  getDocument(options: { url: string }): {
    promise: Promise<PdfDocumentProxy>;
  };
};

const PDFJS_MODULE_URL = "https://mozilla.github.io/pdf.js/build/pdf.mjs";
const PDFJS_WORKER_URL = "https://mozilla.github.io/pdf.js/build/pdf.worker.mjs";
const NEW_EVENT_ID = "new";
const ACTIVITY_TYPE_META: Record<ActivityType, { label: string; icon: string; className: string }> = {
  multiple_choice: {
    label: "選擇題",
    icon: new URL(
      "../../svgs/format_list_bulleted_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg",
      import.meta.url
    ).href,
    className: "type-multiple-choice"
  },
  true_false: {
    label: "是非題",
    icon: new URL("../../svgs/rule_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg", import.meta.url)
      .href,
    className: "type-true-false"
  },
  short_answer: {
    label: "簡答題",
    icon: new URL(
      "../../svgs/tooltip_2_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg",
      import.meta.url
    ).href,
    className: "type-short-answer"
  },
  word_cloud: {
    label: "文字雲",
    icon: new URL("../../svgs/cloud_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg", import.meta.url)
      .href,
    className: "type-word-cloud"
  },
  ranking: {
    label: "排序題",
    icon: new URL(
      "../../svgs/format_list_bulleted_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg",
      import.meta.url
    ).href,
    className: "type-ranking"
  }
};
const DELETE_ICON_URL = new URL(
  "../../svgs/delete_24dp_E3E3E3_FILL0_wght400_GRAD0_opsz24.svg",
  import.meta.url
).href;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
const pdfDocumentCache = new Map<string, Promise<PdfDocumentProxy>>();

async function loadPdfJs() {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import(/* @vite-ignore */ PDFJS_MODULE_URL).then((module) => {
      const pdfJs = module as PdfJsModule;
      pdfJs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfJs;
    });
  }
  return pdfJsModulePromise;
}

async function loadPdfDocument(url: string) {
  let promise = pdfDocumentCache.get(url);
  if (!promise) {
    promise = loadPdfJs().then((pdfJs) => pdfJs.getDocument({ url }).promise);
    pdfDocumentCache.set(url, promise);
  }
  return promise;
}

function clearPdfDocumentCacheForEvent(eventId: string) {
  const filePath = `/api/events/${eventId}/presentation/file`;
  for (const key of pdfDocumentCache.keys()) {
    if (key.startsWith(filePath)) {
      pdfDocumentCache.delete(key);
    }
  }
}

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
    // No activity, no time limit, or activity hasn't started: clear countdown
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
    return () => {
      window.clearInterval(interval);
      // Reset remaining when the effect cleanup runs (activity changes)
      setRemaining(null);
    };
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
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = actionsRef.current;
    if (!el) return;
    const check = () => {
      // If actions container scroll width exceeds client width, collapse to dropdown
      setOverflowing(el.scrollWidth > el.offsetWidth + 2);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [actions]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  return (
    <>
    <header className="app-header">
      <div className="brand" onClick={() => navigate("/")}>
        <img className="logo-full" src={logo} alt="Slihoot" />
        <img className="logo-mark" src={logoSmall} alt="Slihoot" />
      </div>
      <h1 className="header-title">{title}</h1>
      <div className="header-actions" ref={actionsRef} style={overflowing ? { opacity: 0, pointerEvents: "none", position: "absolute" } : undefined}>
        {actions}
      </div>
      {overflowing && actions ? (
        <div className="header-dropdown-wrap" ref={dropdownRef}>
          <button
            className="header-menu-button secondary icon-button"
            aria-label="選單"
            onClick={() => setDropdownOpen((v) => !v)}
          >
            ≡
          </button>
          {dropdownOpen && (
            <div className="header-dropdown" onClick={() => setDropdownOpen(false)}>
              {actions}
            </div>
          )}
        </div>
      ) : null}
    </header>
    <div className="header-spacing"></div>
    </>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner">{message}</div>;
}

function AutoDismissErrorBanner({
  message,
  onDismiss,
  timeoutMs = 5000,
  fadeMs = 400
}: {
  message: string | null;
  onDismiss: () => void;
  timeoutMs?: number;
  fadeMs?: number;
}) {
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (!message) return;

    setIsLeaving(false);
    const fadeTimer = window.setTimeout(() => setIsLeaving(true), Math.max(0, timeoutMs - fadeMs));
    const dismissTimer = window.setTimeout(onDismiss, timeoutMs);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [fadeMs, message, onDismiss, timeoutMs]);

  if (!message) return null;
  return <div className={`error-banner transient${isLeaving ? " is-leaving" : ""}`}>{message}</div>;
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
    <>
    <Header title="主持人登入" />
    <main className="page narrow">
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
    </>
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
    <>
    <Header
      title="加入活動"
      actions={<button onClick={() => navigate("/admin")}>主持人</button>}
    />
    <main className="page narrow">
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
    </>
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
    const search = new URLSearchParams();
    if (title.trim()) search.set("title", title.trim());
    setTitle("");
    navigate(`/admin/event/${NEW_EVENT_ID}${search.toString() ? `?${search.toString()}` : ""}`);
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
      <main className="page">
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
    hasDescription: false,
    hasExplanation: false,
    hasTimeLimit: false,
    allowRepeatAnswers: false,
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
  if (type === "ranking") {
    return currentOptions.length ? currentOptions : [draftOption("項目 A"), draftOption("項目 B")];
  }
  return currentOptions.length ? currentOptions : [draftOption("選項 A"), draftOption("選項 B")];
}

function presentationPageSize(
  presentation: EventPresentationRecord | null | undefined,
  pageNumber: number | null | undefined
) {
  const index = Math.max(0, Number(pageNumber ?? 1) - 1);
  const size = presentation?.pageSizes?.[index];
  if (size && size.width > 0 && size.height > 0) return size;
  return { width: 16, height: 9 };
}

function presentationAspectStyle(
  presentation: EventPresentationRecord | null | undefined,
  pageNumber: number | null | undefined
): React.CSSProperties {
  const size = presentationPageSize(presentation, pageNumber);
  return {
    aspectRatio: `${size.width} / ${size.height}`
  };
}

function presentationStageStyle(
  presentation: EventPresentationRecord | null | undefined,
  pageNumber: number | null | undefined
): React.CSSProperties {
  const size = presentationPageSize(presentation, pageNumber);
  const ratio = size.width / size.height;
  return {
    aspectRatio: `${size.width} / ${size.height}`,
    maxWidth: `min(100%, calc(68vh * ${ratio}))`
  };
}

function wordCloudAllowsRepeat(activity: ActivityRecord) {
  if (typeof activity.allowRepeatAnswers === "boolean") return activity.allowRepeatAnswers;
  if (typeof activity.correctAnswer !== "object" || activity.correctAnswer === null) return false;
  return Boolean((activity.correctAnswer as { allowRepeatAnswers?: unknown }).allowRepeatAnswers);
}

function PdfCanvasPage({
  url,
  pageNumber,
  className,
  style
}: {
  url: string;
  pageNumber: number | null | undefined;
  className: string;
  style?: React.CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setContainerSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height))
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!url || !canvas || containerSize.width <= 0 || containerSize.height <= 0) return;

    const targetCanvas = canvas;
    let cancelled = false;
    let renderTask: PdfRenderTask | null = null;

    async function renderPdfPage() {
      try {
        setError(null);
        const pdfDocument = await loadPdfDocument(url);
        if (cancelled) return;

        const safePageNumber = Math.max(
          1,
          Math.min(Math.floor(Number(pageNumber) || 1), pdfDocument.numPages)
        );
        const page = await pdfDocument.getPage(safePageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          containerSize.width / baseViewport.width,
          containerSize.height / baseViewport.height
        );
        const viewport = page.getViewport({ scale: Number.isFinite(scale) && scale > 0 ? scale : 1 });
        const outputScale = window.devicePixelRatio || 1;
        const context = targetCanvas.getContext("2d");
        if (!context) throw new Error("Canvas is not available.");
        if (cancelled) return;

        targetCanvas.width = Math.floor(viewport.width * outputScale);
        targetCanvas.height = Math.floor(viewport.height * outputScale);
        targetCanvas.style.width = `${viewport.width}px`;
        targetCanvas.style.height = `${viewport.height}px`;

        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);

        renderTask = page.render({
          canvasContext: context,
          viewport
        });
        await renderTask.promise;
        // Verify the canvas actually has non-zero pixel data (detect blank renders)
        if (cancelled) return;
        const imageData = context.getImageData(0, 0, Math.min(10, targetCanvas.width), Math.min(10, targetCanvas.height));
        const hasContent = imageData.data.some((v) => v !== 0);
        if (!hasContent && !cancelled) {
          // Retry once after a short delay
          await new Promise((r) => window.setTimeout(r, 120));
          if (cancelled) return;
          context.clearRect(0, 0, viewport.width, viewport.height);
          renderTask = page.render({ canvasContext: context, viewport });
          await renderTask.promise;
        }
      } catch (error) {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : "PDF render failed.");
        }
      }
    }

    renderPdfPage();

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [containerSize.height, containerSize.width, pageNumber, url]);

  return (
    <div className={className} ref={containerRef} style={style}>
      {url ? <canvas ref={canvasRef} /> : <span>PDF</span>}
      {error ? <small className="pdf-render-error">PDF 載入失敗</small> : null}
    </div>
  );
}

function EventEditorPage({ eventId }: { eventId: string }) {
  const token = getAdminToken();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [draft, setDraft] = useState<ActivityDraft>(() => createDefaultActivityDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [insertAfterTimelineItemId, setInsertAfterTimelineItemId] = useState<string | null>(null);
  const [activityEditorOpen, setActivityEditorOpen] = useState(false);
  const [savedEventSettings, setSavedEventSettings] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const [temporaryEventId, setTemporaryEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [uploadingPresentation, setUploadingPresentation] = useState(false);
  const [draggingTimelineItemId, setDraggingTimelineItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    itemId: string;
    position: "before" | "after";
  } | null>(null);
  const [alarms, setAlarms] = useState<AlarmRecord[]>([]);
  const [bellSongs, setBellSongs] = useState<string[]>([]);
  const [alarmPreviewAudio, setAlarmPreviewAudio] = useState<HTMLAudioElement | null>(null);
  const isNewEvent = eventId === NEW_EVENT_ID;

  const activityListRef = useRef<HTMLElement | null>(null);
  const activityListFlipRef = useRef<Map<string, DOMRect> | null>(null);
  const activityListFlipPendingRef = useRef(false);
  const creatingEventPromiseRef = useRef<Promise<EventDetail | null> | null>(null);
  const timelineDragOriginRef = useRef<EventDetail | null>(null);
  const timelineDropCommittedRef = useRef(false);

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
  }, [event?.timeline]);

  const presentationFileUrl = useMemo(() => {
    if (!event?.presentation || !token || event.id === NEW_EVENT_ID) return "";
    const tokenParam = encodeURIComponent(token);
    const versionParam = encodeURIComponent(`${event.presentation.id}-${event.presentation.updatedAt}`);
    return `/api/events/${event.id}/presentation/file?token=${tokenParam}&v=${versionParam}`;
  }, [event?.id, event?.presentation, token]);

  const load = useCallback(async (preserveCurrentSettings = false, overrideEventId?: string) => {
    if (!token) return;
    try {
      const targetEventId = overrideEventId ?? temporaryEventId ?? (isNewEvent ? null : eventId);
      if (!targetEventId) {
        const title = new URLSearchParams(window.location.search).get("title") ?? "";
        setEvent({
          id: NEW_EVENT_ID,
          title,
          description: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          activities: [],
          presentation: null,
          timeline: []
        });
        setSavedEventSettings({
          title: "",
          description: ""
        });
        return;
      }

      const loaded = await api<EventDetail>(`/api/events/${targetEventId}`, { adminToken: token });
      setEvent((current) =>
        preserveCurrentSettings && current
          ? {
              ...loaded,
              title: current.title,
              description: current.description
            }
          : loaded
      );
      if (!preserveCurrentSettings) {
        setSavedEventSettings({
          title: loaded.title,
          description: loaded.description
        });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "讀取活動失敗");
    }
  }, [eventId, isNewEvent, temporaryEventId, token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadMusicJson().then((music) => {
      setBellSongs(music["bell"] ?? []);
    });
    return () => {
      // Cleanup preview audio
      setAlarmPreviewAudio((prev) => { prev?.pause(); return null; });
    };
  }, []);

  useEffect(() => {
    if (!activityEditorOpen) return;
    const closeOnEscape = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") closeActivityEditor();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityEditorOpen]);

  async function ensureEventRecord() {
    if (!token || !event) return null;
    if (event.id !== NEW_EVENT_ID) return event;
    if (creatingEventPromiseRef.current) return creatingEventPromiseRef.current;

    creatingEventPromiseRef.current = api<EventDetail>("/api/events", {
      method: "POST",
      adminToken: token,
      body: {
        title: event.title,
        description: event.description
      }
    })
      .then((created) => {
        setEvent(created);
        setTemporaryEventId(created.id);
        return created;
      })
      .catch((error) => {
        setError(error instanceof Error ? error.message : "建立暫存活動失敗");
        return null;
      })
      .finally(() => {
        creatingEventPromiseRef.current = null;
      });

    return creatingEventPromiseRef.current;
  }

  async function openNewActivity() {
    const activeEvent = await ensureEventRecord();
    if (!activeEvent) return;

    setEditingId(null);
    setInsertAfterTimelineItemId(null);
    setDraft(createDefaultActivityDraft());
    setActivityEditorOpen(true);
  }

  function editActivity(activity: ActivityRecord) {
    setEditingId(activity.id);
    setInsertAfterTimelineItemId(null);
    setActivityEditorOpen(true);
    setDraft({
      type: activity.type,
      title: activity.title,
      description: activity.description,
      explanation: activity.explanation,
      hasDescription: Boolean(activity.description),
      hasExplanation: Boolean(activity.explanation),
      hasTimeLimit: activity.timeLimitSeconds > 0,
      allowRepeatAnswers: activity.type === "word_cloud" ? wordCloudAllowsRepeat(activity) : false,
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
      description: draft.hasDescription ? draft.description : "",
      explanation: draft.hasExplanation ? draft.explanation : "",
      timeLimitSeconds: draft.hasTimeLimit ? draft.timeLimitSeconds : 0,
      options: draft.options
        .map((option) => ({ ...option, label: option.label.trim() }))
        .filter((option) => option.label),
      correctAnswer:
        draft.type === "word_cloud"
          ? { allowRepeatAnswers: draft.allowRepeatAnswers }
          : draft.type === "short_answer"
            ? draft.correctText.trim()
              ? { text: draft.correctText.trim() }
              : null
            : draft.type === "ranking"
              ? null
              : draft.correctOptionId
                ? { optionId: draft.correctOptionId }
                : null,
      insertAfterTimelineItemId: editingId ? null : insertAfterTimelineItemId
    };
  }

  async function saveEvent(eventForm: React.FormEvent) {
    eventForm.preventDefault();
    if (!token || !event) return;
    try {
      const updated = event.id === NEW_EVENT_ID
        ? await api<EventDetail>("/api/events", {
            method: "POST",
            adminToken: token,
            body: {
              title: event.title,
              description: event.description
            }
          })
        : await api<EventDetail>(`/api/events/${event.id}`, {
            method: "PUT",
            adminToken: token,
            body: {
              title: event.title,
              description: event.description
            }
          });
      setEvent(updated);
      setSavedEventSettings({
        title: updated.title,
        description: updated.description
      });
      setTemporaryEventId(null);
      navigate("/admin/dashboard");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to save event.");
    }
  }

  function eventSettingsChanged() {
    if (!event || !savedEventSettings) return false;
    return (
      event.title !== savedEventSettings.title ||
      event.description !== savedEventSettings.description
    );
  }

  async function backToDashboard() {
    const hasTemporaryEvent = isNewEvent && event?.id !== NEW_EVENT_ID;
    if ((eventSettingsChanged() || hasTemporaryEvent) && !confirm("活動尚未儲存。確定不儲存並回列表嗎？")) {
      return;
    }
    if (hasTemporaryEvent && token && event) {
      try {
        await api(`/api/events/${event.id}`, { method: "DELETE", adminToken: token });
      } catch (error) {
        setError(error instanceof Error ? error.message : "刪除暫存活動失敗");
        return;
      }
    }
    navigate("/admin/dashboard");
  }

  async function saveActivity(activityForm: React.FormEvent) {
    activityForm.preventDefault();
    if (!token || !event) return;
    const activeEvent = await ensureEventRecord();
    if (!activeEvent) return;
    // 限時開著就一定要填秒數；空白 → 提醒（要不限時請關閉「限時」拉桿，送出 0）。
    if (draft.hasTimeLimit && (!draft.timeLimitSeconds || draft.timeLimitSeconds < 1)) {
      window.alert("請輸入作答秒數，或關閉「限時」改為不限時。");
      return;
    }
    try {
      if (editingId) {
        await api(`/api/activities/${editingId}`, {
          method: "PUT",
          adminToken: token,
          body: payloadFromDraft()
        });
      } else {
        await api(`/api/events/${activeEvent.id}/activities`, {
          method: "POST",
          adminToken: token,
          body: payloadFromDraft()
        });
      }
      setError(null);
      setDraft(createDefaultActivityDraft());
      setEditingId(null);
      setInsertAfterTimelineItemId(null);
      setActivityEditorOpen(false);
      await load(true, activeEvent.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "儲存題目失敗");
    }
  }

  async function removeActivity(activityId: string) {
    if (!token || !confirm("刪除此題？")) return;
    await api(`/api/activities/${activityId}`, { method: "DELETE", adminToken: token });
    await load(true);
  }

  async function uploadPresentation(file: File | null) {
    if (!token || !event || !file) return;
    const activeEvent = await ensureEventRecord();
    if (!activeEvent) return;
    setUploadingPresentation(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/events/${activeEvent.id}/presentation`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: form
      });
      const updated = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(updated.error ?? "上傳 PDF 失敗");
      }
      clearPdfDocumentCacheForEvent(activeEvent.id);
      setEvent((current) =>
        current
          ? {
              ...(updated as EventDetail),
              title: current.title,
              description: current.description
            }
          : (updated as EventDetail)
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "上傳 PDF 失敗");
    } finally {
      setUploadingPresentation(false);
    }
  }

  async function removePresentation() {
    if (!token || !event?.presentation || uploadingPresentation) return;
    if (!confirm("移除已匯入的 PDF？相關簡報頁也會從流程中移除。")) return;

    setUploadingPresentation(true);
    setError(null);
    try {
      const updated = await api<EventDetail>(`/api/events/${event.id}/presentation`, {
        method: "DELETE",
        adminToken: token
      });
      clearPdfDocumentCacheForEvent(event.id);
      setEvent((current) =>
        current
          ? {
              ...updated,
              title: current.title,
              description: current.description
            }
          : updated
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "移除 PDF 失敗");
    } finally {
      setUploadingPresentation(false);
    }
  }

  async function persistTimelineOrder(nextTimeline: TimelineItemRecord[], previousEvent: EventDetail) {
    if (!token) return;
    setReordering(true);
    try {
      const reordered = await api<TimelineItemRecord[]>(`/api/events/${previousEvent.id}/timeline/reorder`, {
        method: "PUT",
        adminToken: token,
        body: { timelineItemIds: nextTimeline.map((item) => item.id) }
      });
      setEvent((current) => (current ? { ...current, timeline: reordered } : current));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to reorder timeline.");
      setEvent(previousEvent);
    } finally {
      setReordering(false);
    }
  }

  function previewTimelineMove(targetItem: TimelineItemRecord, position: "before" | "after") {
    if (!draggingTimelineItemId) return;

    setEvent((current) => {
      if (!current) return current;

      const draggedItem = current.timeline.find((item) => item.id === draggingTimelineItemId);
      if (!draggedItem || draggedItem.type !== "activity" || draggedItem.id === targetItem.id) {
        return current;
      }

      const timelineWithoutDragged = current.timeline.filter((item) => item.id !== draggedItem.id);
      const targetIndex = timelineWithoutDragged.findIndex((item) => item.id === targetItem.id);
      if (targetIndex === -1) return current;

      const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
      const nextTimeline = [...timelineWithoutDragged];
      nextTimeline.splice(insertIndex, 0, draggedItem);

      if (
        nextTimeline.map((item) => item.id).join("|") ===
        current.timeline.map((item) => item.id).join("|")
      ) {
        return current;
      }

      recordActivityListFlip();
      return { ...current, timeline: nextTimeline };
    });
  }

  function handleTimelineDragOver(dragEvent: React.DragEvent<HTMLElement>, item: TimelineItemRecord) {
    if (!draggingTimelineItemId || draggingTimelineItemId === item.id) return;
    dragEvent.preventDefault();
    dragEvent.dataTransfer.dropEffect = "move";

    const rect = dragEvent.currentTarget.getBoundingClientRect();
    const position = dragEvent.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropTarget({ itemId: item.id, position });
    previewTimelineMove(item, position);
  }

  function startTimelineDrag(dragEvent: React.DragEvent<HTMLElement>, item: TimelineItemRecord) {
    if (!event || item.type !== "activity" || reordering) {
      dragEvent.preventDefault();
      return;
    }

    const rect = dragEvent.currentTarget.getBoundingClientRect();
    dragEvent.dataTransfer.effectAllowed = "move";
    dragEvent.dataTransfer.setData("text/plain", item.id);
    dragEvent.dataTransfer.setDragImage(
      dragEvent.currentTarget,
      dragEvent.clientX - rect.left,
      dragEvent.clientY - rect.top
    );
    timelineDragOriginRef.current = event;
    timelineDropCommittedRef.current = false;
    setDraggingTimelineItemId(item.id);
  }

  function finishTimelineDrag() {
    if (!timelineDropCommittedRef.current && timelineDragOriginRef.current) {
      setEvent(timelineDragOriginRef.current);
    }
    timelineDragOriginRef.current = null;
    timelineDropCommittedRef.current = false;
    setDraggingTimelineItemId(null);
    setDropTarget(null);
  }

  async function dropTimelineItem(dropEvent: React.DragEvent<HTMLElement>) {
    dropEvent.preventDefault();
    if (!event || reordering || !draggingTimelineItemId) return;

    const previousEvent = timelineDragOriginRef.current ?? event;
    const nextTimeline = event.timeline;
    const orderChanged =
      nextTimeline.map((item) => item.id).join("|") !==
      previousEvent.timeline.map((item) => item.id).join("|");

    timelineDropCommittedRef.current = true;
    setDraggingTimelineItemId(null);
    setDropTarget(null);

    if (orderChanged) {
      await persistTimelineOrder(nextTimeline, previousEvent);
    }

    timelineDragOriginRef.current = null;
  }

  async function prepareInsertAfter(item: TimelineItemRecord) {
    const activeEvent = await ensureEventRecord();
    if (!activeEvent) return;

    setEditingId(null);
    setInsertAfterTimelineItemId(item.id);
    setDraft(createDefaultActivityDraft());
    setActivityEditorOpen(true);
  }

  function closeActivityEditor() {
    setActivityEditorOpen(false);
    setEditingId(null);
    setInsertAfterTimelineItemId(null);
    setDraft(createDefaultActivityDraft());
  }

  if (!event) {
    return (
      <AdminGuard>
        <Header title="活動編輯" />
        <main className="page">
          <p className="muted">讀取中...</p>
        </main>
      </AdminGuard>
    );
  }

  return (
    <AdminGuard>
      <Header
        title="活動編輯"
        actions={
          <>
            <button className="secondary" onClick={backToDashboard}>
              回列表
            </button>
            <button form="event-settings-form">儲存活動</button>
          </>
        }
      />
      <main className="page">
        <ErrorBanner message={error} />
        <div className="event-editor-layout">
        <aside className="panel event-settings-panel">
          <form id="event-settings-form" className="event-fields" onSubmit={saveEvent}>
            <label>
              標題
              <input
                value={event.title}
                onChange={(change) => setEvent({ ...event, title: change.target.value })}
              />
            </label>
            <label>
              描述
              <textarea
                value={event.description}
                onChange={(change) => setEvent({ ...event, description: change.target.value })}
              />
            </label>
          </form>
          <div className="event-editor-toolbar">
            <div className="button-row">
              {event.presentation ? (
                <button
                  className="file-import-button presentation-delete-button"
                  type="button"
                  disabled={uploadingPresentation}
                  onClick={removePresentation}
                >
                  <img src={DELETE_ICON_URL} alt="" aria-hidden="true" />
                  刪除 PDF
                </button>
              ) : (
                <label className="file-import-button" aria-disabled={uploadingPresentation}>
                  <span aria-hidden="true">+</span>
                  匯入 PDF
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    disabled={uploadingPresentation}
                    onChange={(change) => {
                      uploadPresentation(change.target.files?.[0] ?? null);
                      change.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            <div className="presentation-status">
              {event.presentation ? (
                <p className="muted">
                  已載入：{event.presentation.originalName}（{event.presentation.pageCount} 頁）
                </p>
              ) : (
                <p className="muted">尚未上傳簡報。可直接匯入 PDF，未儲存離開時不會保留。</p>
              )}
              {uploadingPresentation ? <p className="muted">PDF 上傳中...</p> : null}
            </div>
          </div>
          {/* ─── Alarms ─────────────────────────────────── */}
          <div className="event-alarms-panel">
            <h3>鬧鐘</h3>
            <p className="muted" style={{fontSize:"0.82rem"}}>在直播進行中，到達指定時間自動播放鈴聲。</p>
            {alarms.map((alarm, i) => (
              <div key={alarm.id} className="alarm-row">
                <input
                  type="time"
                  value={alarm.time}
                  onChange={(e) => {
                    const next = [...alarms];
                    next[i] = { ...alarm, time: e.target.value };
                    setAlarms(next);
                  }}
                  className="alarm-time-input"
                />
                <select
                  value={alarm.songFile}
                  onChange={(e) => {
                    const next = [...alarms];
                    next[i] = { ...alarm, songFile: e.target.value };
                    setAlarms(next);
                  }}
                  className="alarm-song-select"
                >
                  <option value="">選擇鈴聲</option>
                  {bellSongs.map((song) => (
                    <option key={song} value={song}>{song.replace(/\.[^.]+$/, "")}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button secondary"
                  title="試聽"
                  onClick={() => {
                    if (alarmPreviewAudio) { alarmPreviewAudio.pause(); }
                    if (alarm.songFile) {
                      const a = new Audio(`/${alarm.songFile}`);
                      a.play().catch(() => {});
                      setAlarmPreviewAudio(a);
                    }
                  }}
                >▶</button>
                <button
                  type="button"
                  className="icon-button danger"
                  title="刪除"
                  onClick={() => setAlarms(alarms.filter((_, j) => j !== i))}
                >×</button>
              </div>
            ))}
            <button
              type="button"
              className="secondary icon-text-button"
              onClick={() => setAlarms([...alarms, { id: crypto.randomUUID(), time: "09:00", songFile: bellSongs[0] ?? "" }])}
            >
              <span>+</span>
              新增鬧鐘
            </button>
          </div>
        </aside>

        {activityEditorOpen ? (
          <div
            className="modal-layer"
            role="presentation"
            onMouseDown={(mouseEvent) => {
              if (mouseEvent.target === mouseEvent.currentTarget) closeActivityEditor();
            }}
          >
            <section
              className="activity-editor-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="activity-editor-title"
              onMouseDown={(mouseEvent) => mouseEvent.stopPropagation()}
            >
              <div className="activity-editor-header">
                <div>
                  <h2 id="activity-editor-title">
                    {editingId
                      ? "編輯題目"
                      : insertAfterTimelineItemId
                        ? "插入題目"
                        : "新增題目"}
                  </h2>
                </div>
                <button
                  className="icon-button close-button"
                  type="button"
                  aria-label="關閉題目編輯"
                  title="關閉"
                  onClick={closeActivityEditor}
                >
                  ×
                </button>
              </div>
              <form className="activity-editor-form" onSubmit={saveActivity}>
                <label className="question-primary-field">
                  題目
                  <textarea
                    className="question-title-input"
                    value={draft.title}
                    onChange={(change) => setDraft({ ...draft, title: change.target.value })}
                  />
                </label>

                <div className="activity-control-strip">
                  <div className="activity-control-left">
                    <label className="activity-type-field">
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
                        <option value="ranking">排序題</option>
                      </select>
                    </label>

                    <div className="time-setting-group">
                      <span className="field-label">設定時間</span>
                      <div className="time-setting-controls">
                        <label className="toggle-row compact-toggle">
                          <span>
                            <strong>限時</strong>
                          </span>
                          <input
                            type="checkbox"
                            checked={draft.hasTimeLimit}
                            onChange={(change) =>
                              setDraft({
                                ...draft,
                                hasTimeLimit: change.target.checked,
                                timeLimitSeconds:
                                  change.target.checked && draft.timeLimitSeconds <= 0
                                    ? 30
                                    : draft.timeLimitSeconds
                              })
                            }
                          />
                        </label>
                        <label
                          className={[
                            "inline-number-field",
                            "time-seconds-field",
                            draft.hasTimeLimit ? "" : "disabled"
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          <span className="seconds-input-shell">
                            <input
                              type="number"
                              min={1}
                              max={3600}
                              disabled={!draft.hasTimeLimit}
                              value={draft.timeLimitSeconds || ""}
                              onChange={(change) => {
                                // Allow the field to be cleared (0/blank) so the
                                // user can leave it empty — saveActivity then
                                // alerts instead of silently defaulting.
                                const raw = Math.floor(Number(change.target.value));
                                setDraft({
                                  ...draft,
                                  timeLimitSeconds: Number.isFinite(raw)
                                    ? Math.min(3600, Math.max(0, raw))
                                    : 0
                                });
                              }}
                            />
                            <span className="seconds-suffix">秒</span>
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="activity-control-right">
                    <label className="toggle-row compact-toggle">
                      <span>
                        <strong>補充說明</strong>
                      </span>
                      <input
                        type="checkbox"
                        checked={draft.hasDescription}
                        onChange={(change) =>
                          setDraft({
                            ...draft,
                            hasDescription: change.target.checked,
                            description: change.target.checked ? draft.description : ""
                          })
                        }
                      />
                    </label>

                    <label className="toggle-row compact-toggle">
                      <span>
                        <strong>提供詳解</strong>
                      </span>
                      <input
                        type="checkbox"
                        checked={draft.hasExplanation}
                        onChange={(change) =>
                          setDraft({
                            ...draft,
                            hasExplanation: change.target.checked,
                            explanation: change.target.checked ? draft.explanation : ""
                          })
                        }
                      />
                    </label>

                    {draft.type === "word_cloud" ? (
                      <label className="toggle-row compact-toggle">
                        <span>
                          <strong>允許重複填答</strong>
                        </span>
                        <input
                          type="checkbox"
                          checked={draft.allowRepeatAnswers}
                          onChange={(change) =>
                            setDraft({ ...draft, allowRepeatAnswers: change.target.checked })
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                </div>

                {draft.hasDescription ? (
                  <textarea
                    className="expanded-field"
                    aria-label="補充說明"
                    value={draft.description}
                    onChange={(change) => setDraft({ ...draft, description: change.target.value })}
                    placeholder="輸入題目補充說明"
                  />
                ) : null}

                {draft.hasExplanation ? (
                  <textarea
                    className="expanded-field"
                    aria-label="詳解"
                    value={draft.explanation}
                    onChange={(change) => setDraft({ ...draft, explanation: change.target.value })}
                    placeholder="時間到後向參與者顯示的解析"
                  />
                ) : null}

                {draft.type === "multiple_choice" || draft.type === "true_false" ? (
                  <div className="form-stack option-editor-card">
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
                              className="icon-button secondary"
                              type="button"
                              disabled={draft.options.length <= 2}
                              aria-label={`移除選項 ${index + 1}`}
                              title="移除選項"
                              onClick={() => {
                                const nextOptions = draft.options.filter(
                                  (candidate) => candidate.id !== option.id
                                );
                                setDraft({
                                  ...draft,
                                  options: nextOptions,
                                  correctOptionId:
                                    draft.correctOptionId === option.id
                                      ? ""
                                      : draft.correctOptionId
                                });
                              }}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {draft.type === "multiple_choice" ? (
                      <button
                        className="secondary icon-text-button"
                        type="button"
                        disabled={draft.options.length >= 6}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            options: [
                              ...draft.options,
                              draftOption(`選項 ${draft.options.length + 1}`)
                            ]
                          })
                        }
                      >
                        <span aria-hidden="true">+</span>
                        選項
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {draft.type === "ranking" ? (
                  <div className="form-stack option-editor-card ranking-editor-card">
                    <span className="field-label">排序項目（拖曳調整，由上到下為正確順序）</span>
                    <SortableList
                      items={draft.options}
                      onReorder={(orderedIds) =>
                        setDraft({
                          ...draft,
                          options: orderedIds
                            .map((optionId) =>
                              draft.options.find((option) => option.id === optionId)
                            )
                            .filter((option): option is ActivityOption => Boolean(option))
                        })
                      }
                      renderItem={(option, index) => (
                        <>
                          <input
                            value={option.label}
                            onPointerDown={(pointer) => pointer.stopPropagation()}
                            onChange={(change) =>
                              setDraft({
                                ...draft,
                                options: draft.options.map((candidate) =>
                                  candidate.id === option.id
                                    ? { ...candidate, label: change.target.value }
                                    : candidate
                                )
                              })
                            }
                            placeholder={`項目 ${index + 1}`}
                          />
                          <button
                            className="icon-button secondary"
                            type="button"
                            onPointerDown={(pointer) => pointer.stopPropagation()}
                            disabled={draft.options.length <= 2}
                            aria-label={`移除項目 ${index + 1}`}
                            title="移除項目"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                options: draft.options.filter((candidate) => candidate.id !== option.id)
                              })
                            }
                          >
                            ×
                          </button>
                        </>
                      )}
                    />
                    <button
                      className="secondary icon-text-button"
                      type="button"
                      disabled={draft.options.length >= 6}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          options: [
                            ...draft.options,
                            draftOption(`項目 ${draft.options.length + 1}`)
                          ]
                        })
                      }
                    >
                      <span aria-hidden="true">+</span>
                      項目
                    </button>
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
                <div className="modal-actions">
                  <button>{editingId ? "更新題目" : "新增題目"}</button>
                  <button className="secondary" type="button" onClick={closeActivityEditor}>
                    取消
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}

        <section className="event-timeline-column">
        <section className="timeline-list" ref={activityListRef}>
          <div className="timeline-heading">
            <h2>簡報流程</h2>
            <p className="muted">
              PDF 頁與題目會照這個順序播放。參與者只會在題目頁開始作答時看到題目。
            </p>
          </div>
          <div className="timeline-items-scroll">
            {event.timeline.length === 0 ? (
              <div className="empty-timeline-insert">
                <p className="muted">尚未新增簡報頁或題目。</p>
                <button className="icon-text-button" type="button" onClick={openNewActivity}>
                  <span aria-hidden="true">+</span>
                  新增第一題
                </button>
              </div>
            ) : null}
            {event.timeline.map((item, index) => {
              const activity = item.activity ?? event.activities.find((candidate) => candidate.id === item.activityId);
              const isPdfPage = item.type === "pdf_page";
              const isDropTarget = dropTarget?.itemId === item.id;
              const activityMeta = activity ? ACTIVITY_TYPE_META[activity.type] : null;
              const activityNumber = event.timeline
                .slice(0, index + 1)
                .filter((candidate) => candidate.type === "activity").length;
              return (
                <Fragment key={item.id}>
                <article
                  className={[
                    "item-card",
                    "timeline-card",
                    isPdfPage ? "pdf-card" : "activity-card",
                    draggingTimelineItemId === item.id ? "dragging" : "",
                    isDropTarget ? `drop-${dropTarget.position}` : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-flip-id={item.id}
                  draggable={Boolean(activity) && !reordering}
                  onDragStart={(dragEvent) => startTimelineDrag(dragEvent, item)}
                  onDragEnd={finishTimelineDrag}
                  onDragOver={(dragEvent) => handleTimelineDragOver(dragEvent, item)}
                  onDrop={dropTimelineItem}
                  onDragLeave={(dragEvent) => {
                    const relatedTarget = dragEvent.relatedTarget;
                    if (
                      relatedTarget instanceof Node &&
                      dragEvent.currentTarget.contains(relatedTarget)
                    ) {
                      return;
                    }
                    setDropTarget((current) => (current?.itemId === item.id ? null : current));
                  }}
                >
                  <div className="timeline-card-body">
                    {isPdfPage ? (
                      <>
                        <PdfCanvasPage
                          className="pdf-page-preview"
                          url={presentationFileUrl}
                          pageNumber={item.pageNumber}
                          style={presentationAspectStyle(event.presentation, item.pageNumber)}
                        />
                        <div>
                          <h3>簡報 Page {item.pageNumber}</h3>
                        </div>
                      </>
                    ) : activity ? (
                      <>
                        <div
                          className={[
                            "activity-type-icon",
                            activityMeta?.className ?? ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          aria-hidden="true"
                        >
                          {activityMeta ? <img src={activityMeta.icon} alt="" /> : null}
                        </div>
                        <div>
                          <small>
                            第 {activityNumber} 題 · {activityMeta?.label ?? "題目"}
                            {activity.timeLimitSeconds > 0 ? ` · ${activity.timeLimitSeconds} 秒` : " · 不限時"}
                          </small>
                          <h2>{activity.title}</h2>
                        </div>
                      </>
                    ) : (
                      <div>
                        <small>題目</small>
                        <h2>題目不存在</h2>
                        <p>這個時間軸項目連到已刪除的題目。</p>
                      </div>
                    )}
                  </div>
                  <div className="button-row timeline-actions">
                    {activity ? (
                      <>
                        <button
                          className="icon-button"
                          aria-label="編輯題目"
                          title="編輯題目"
                          onClick={() => editActivity(activity)}
                        >
                          ✎
                        </button>
                        <button
                          className="icon-button danger"
                          aria-label="刪除題目"
                          title="刪除題目"
                          onClick={() => removeActivity(activity.id)}
                        >
                          ×
                        </button>
                      </>
                    ) : null}
                  </div>
                </article>
                <div
                  className={[
                    "timeline-insert-slot",
                    index === event.timeline.length - 1 ? "final" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    className="timeline-insert-button"
                    type="button"
                    aria-label="在此處新增題目"
                    title="在此處新增題目"
                    onClick={() => prepareInsertAfter(item)}
                  >
                    +
                  </button>
                </div>
                </Fragment>
              );
            })}
          </div>
        </section>
        </section>
        </div>
      </main>
    </AdminGuard>
  );
}

function Leaderboard({
  entries,
  meId,
  title = "排行榜"
}: {
  entries?: LeaderboardEntry[];
  meId?: string | null;
  title?: string;
}) {
  if (!entries?.length) return null;
  return (
    <section className="results-panel leaderboard-panel">
      <h2>{title}</h2>
      <ol className="leaderboard">
        {entries.map((entry) => (
          <li
            key={entry.participantId}
            className={meId && entry.participantId === meId ? "leaderboard-row me" : "leaderboard-row"}
          >
            <span className="rank">{entry.rank}</span>
            <span className="name">{entry.nickname}</span>
            <strong className="score">{entry.score}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Drag-to-reorder list built on Pointer Events so it works with both mouse and
// touch (phones). Controlled: emits the new id order via onReorder. Children of
// each row come from renderItem; interactive children (inputs/buttons) should
// stopPropagation on pointerdown so they don't start a drag.
function SortableList({
  items,
  disabled,
  onReorder,
  renderItem
}: {
  items: ActivityOption[];
  disabled?: boolean;
  onReorder: (orderedIds: string[]) => void;
  renderItem: (option: ActivityOption, index: number) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLUListElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const orderKeyRef = useRef<string>("");
  const slotMidpointsRef = useRef<number[]>([]);

  // Stable badge number that stays with each option: assigned by the order an
  // option is first seen, so dragging reorders the blocks but each keeps its
  // original number (1,2,3,4,5 dragged into 1,3,2,4,5). Resets when the item set
  // changes entirely (e.g. switching to a different question).
  const numberByIdRef = useRef<Map<string, number>>(new Map());
  const maxNumberRef = useRef(0);
  if (numberByIdRef.current.size > 0 && !items.some((option) => numberByIdRef.current.has(option.id))) {
    numberByIdRef.current = new Map();
    maxNumberRef.current = 0;
  }
  for (const option of items) {
    if (!numberByIdRef.current.has(option.id)) {
      maxNumberRef.current += 1;
      numberByIdRef.current.set(option.id, maxNumberRef.current);
    }
  }

  // FLIP: when the *order* actually changes (a reorder), slide each non-dragged
  // block from its old position to its new one. Gated on the id sequence so it
  // never fires on unrelated re-renders (e.g. typing a label in the editor),
  // which previously caused jumpiness.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const blocks = Array.from(container.querySelectorAll<HTMLElement>("[data-sortable-id]"));
    const orderKey = items.map((option) => option.id).join(",");
    const orderChanged = orderKey !== orderKeyRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = orderChanged && Boolean(orderKeyRef.current) && !reduceMotion;

    // Only on a real reorder: cancel any in-flight slide so getBoundingClientRect
    // reads the true resting layout. Left untouched on unrelated re-renders
    // (typing, hover) so CSS transitions aren't disturbed.
    if (animate) {
      for (const block of blocks) for (const a of block.getAnimations()) a.cancel();
    }

    const nextRects = new Map<string, DOMRect>();
    for (const block of blocks) nextRects.set(block.dataset.sortableId!, block.getBoundingClientRect());

    if (animate) {
      for (const block of blocks) {
        const id = block.dataset.sortableId!;
        if (id === draggingRef.current) continue;
        const prev = prevRectsRef.current.get(id);
        const next = nextRects.get(id);
        if (!prev || !next) continue;
        const deltaY = prev.top - next.top;
        if (Math.abs(deltaY) < 0.5) continue;
        block.animate([{ transform: `translateY(${deltaY}px)` }, { transform: "translateY(0)" }], {
          duration: 130,
          easing: "ease-out"
        });
      }
    }

    prevRectsRef.current = nextRects;
    orderKeyRef.current = orderKey;
  });

  function moveDraggedTo(targetIndex: number) {
    if (draggingId === null) return;
    const currentIndex = items.findIndex((option) => option.id === draggingId);
    if (currentIndex === -1 || currentIndex === targetIndex) return;
    const next = [...items];
    const [moved] = next.splice(currentIndex, 1);
    next.splice(targetIndex, 0, moved!);
    onReorder(next.map((option) => option.id));
  }

  function handlePointerMove(event: React.PointerEvent) {
    if (draggingId === null) return;
    // Target the slot whose fixed midpoint the pointer has passed. Using the
    // slot geometry captured at drag start (not live, animating rects) keeps the
    // reorder stable and symmetric — reading live positions made downward drags
    // pick up mid-animation rects and ghost.
    const midpoints = slotMidpointsRef.current;
    if (!midpoints.length) return;
    let targetIndex = 0;
    for (const midpoint of midpoints) {
      if (event.clientY > midpoint) targetIndex += 1;
    }
    moveDraggedTo(Math.min(targetIndex, items.length - 1));
  }

  const endDrag = () => {
    draggingRef.current = null;
    setDraggingId(null);
  };

  return (
    <ul
      className="sortable-list"
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {items.map((option, index) => (
        <li
          key={option.id}
          data-sortable-id={option.id}
          className={`sortable-item${draggingId === option.id ? " dragging" : ""}${
            disabled ? " disabled" : ""
          }`}
          style={disabled ? undefined : { touchAction: "none" }}
          onPointerDown={(event) => {
            if (disabled) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            // Snapshot each slot's midpoint (resting layout) for stable targeting.
            const container = containerRef.current;
            slotMidpointsRef.current = container
              ? Array.from(container.querySelectorAll<HTMLElement>("[data-sortable-id]")).map(
                  (block) => {
                    const rect = block.getBoundingClientRect();
                    return rect.top + rect.height / 2;
                  }
                )
              : [];
            draggingRef.current = option.id;
            setDraggingId(option.id);
          }}
        >
          <span className="drag-handle" aria-hidden>
            ⠿
          </span>
          <span className="rank">{numberByIdRef.current.get(option.id) ?? index + 1}</span>
          {renderItem(option, index)}
        </li>
      ))}
    </ul>
  );
}

function SummaryView({ summary }: { summary: ResponseSummary | null }) {
  if (!summary) return <p className="muted">尚未開放或沒有結果。</p>;

  if (summary.type === "ranking") {
    return (
      <div className="answer-list">
        {summary.correctOrder?.length ? (
          <>
            <p className="muted">
              正確順序
              {typeof summary.correctCount === "number"
                ? `（答對 ${summary.correctCount} / ${summary.total} 人）`
                : null}
            </p>
            <ol className="result-order">
              {summary.correctOrder.map((entry, index) => (
                <li className="result-order-item" key={`${entry.number}-${index}`}>
                  <span className="rank">{entry.number}</span>
                  <span className="name">{entry.label}</span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="muted">尚未設定正確順序。</p>
        )}
        {summary.responses?.length ? (
          <div className="answer-list">
            {summary.responses.map((response, index) => (
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
            ))}
          </div>
        ) : null}
      </div>
    );
  }

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
  currentParticipantId,
  chatError,
  onChatErrorDismiss,
  onChatOpenChange,
  onSend,
  onModerate
}: {
  role: "admin" | "participant";
  messages: LiveMessageRecord[];
  currentParticipantId?: string | null;
  chatError?: { id: number; message: string } | null;
  onChatErrorDismiss?: () => void;
  onChatOpenChange?: (isOpen: boolean) => void;
  onSend?: (content: string) => void;
  onModerate?: (messageId: string, action: string, content?: string) => void;
}) {
  const [content, setContent] = useState("");
  const [isOpen, setIsOpenRaw] = useState(role === "admin");
  const setIsOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setIsOpenRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      onChatOpenChange?.(next);
      return next;
    });
  }, [onChatOpenChange]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeModerationMessageId, setActiveModerationMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const knownMessageIdsRef = useRef<Set<string> | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const panelId = useId();
  const visibleMessages = useMemo(
    () =>
      messages
        .filter((message) => message.status !== "deleted")
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        }),
    [messages]
  );

  useEffect(() => {
    const currentIds = new Set(visibleMessages.map((message) => message.id));
    const knownIds = knownMessageIdsRef.current;

    if (!knownIds) {
      knownMessageIdsRef.current = currentIds;
      return;
    }

    let newMessages = 0;
    for (const messageId of currentIds) {
      if (!knownIds.has(messageId)) newMessages += 1;
    }

    if (newMessages > 0 && !isOpen) {
      setUnreadCount((current) => Math.min(99, current + newMessages));
    }

    knownMessageIdsRef.current = currentIds;
  }, [isOpen, visibleMessages]);

  useEffect(() => {
    if (isOpen) setUnreadCount(0);
  }, [isOpen]);

  useEffect(() => {
    if (!chatError) return;
    setIsOpen(true);
    const timer = window.setTimeout(() => onChatErrorDismiss?.(), 2600);
    return () => window.clearTimeout(timer);
  }, [chatError, onChatErrorDismiss]);

  useEffect(() => {
    if (!visibleMessages.some((message) => message.id === activeModerationMessageId)) {
      setActiveModerationMessageId(null);
    }
  }, [activeModerationMessageId, visibleMessages]);

  useEffect(() => {
    if (!visibleMessages.some((message) => message.id === editingMessageId)) {
      setEditingMessageId(null);
      setEditingContent("");
    }
  }, [editingMessageId, visibleMessages]);

  useLayoutEffect(() => {
    const input = chatInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }, [content]);

  useLayoutEffect(() => {
    const input = editInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, [editingContent]);

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    onSend?.(content);
    setContent("");
  }

  function handleMessageInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!content.trim()) return;
    onSend?.(content);
    setContent("");
  }

  function moderateMessage(messageId: string, action: string) {
    onModerate?.(messageId, action);
    setActiveModerationMessageId(null);
  }

  function startEditingMessage(message: LiveMessageRecord) {
    setEditingMessageId(message.id);
    setEditingContent(message.content);
    setActiveModerationMessageId(null);
    window.setTimeout(() => editInputRef.current?.focus(), 0);
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setEditingContent("");
  }

  function saveEditingMessage() {
    if (!editingMessageId) return;
    const nextContent = editingContent.trim();
    if (!nextContent) return;
    onModerate?.(editingMessageId, "edit", nextContent);
    setEditingMessageId(null);
    setEditingContent("");
  }

  function handleEditInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditingMessage();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    saveEditingMessage();
  }

  return (
    <div className={`floating-chat ${isOpen ? "is-open" : "is-collapsed"} ${role}`}>
      {isOpen ? (
        <aside className="chat-panel floating-chat-panel" id={panelId}>
          <div className="chat-header">
            <div className="chat-title">
              <h2>Q&A</h2>
              <small>{visibleMessages.length} 則</small>
            </div>
            <button
              type="button"
              className="icon-button chat-close-button"
              aria-label="收合 Q&A"
              onClick={() => setIsOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="messages">
            {visibleMessages.length ? (
              visibleMessages.map((message) => {
                const canManageMessage =
                  Boolean(onModerate) &&
                  (role === "admin" ||
                    (role === "participant" &&
                      Boolean(currentParticipantId) &&
                      message.participantId === currentParticipantId));
                const canEditMessage =
                  Boolean(onModerate) &&
                  ((role === "admin" && message.participantId === null) ||
                    (role === "participant" &&
                      Boolean(currentParticipantId) &&
                      message.participantId === currentParticipantId));
                const isOwnMessage =
                  (role === "admin" && message.participantId === null) ||
                  (role === "participant" &&
                    Boolean(currentParticipantId) &&
                    message.participantId === currentParticipantId);
                const isModerating = canManageMessage && activeModerationMessageId === message.id;
                const isEditing = canEditMessage && editingMessageId === message.id;
                return (
                  <div
                    className={`message-shell${canManageMessage ? " manageable-message" : ""}${
                      isModerating ? " is-moderating" : ""
                    }${message.participantId === null ? " host-message" : ""}${
                      isOwnMessage ? " own-message" : " other-message"
                    }`}
                    key={message.id}
                  >
                    <article className={`message ${message.status}`}>
                      <div className="message-meta">
                        <strong>{message.participantName}</strong>
                        {message.pinned ? <span>釘選</span> : null}
                        {role === "admin" && message.status !== "visible" ? (
                          <span>{message.status}</span>
                        ) : null}
                      </div>
                      {isEditing ? (
                        <div className="message-edit-form">
                          <textarea
                            ref={editInputRef}
                            value={editingContent}
                            onChange={(event) => setEditingContent(event.target.value)}
                            onKeyDown={handleEditInputKeyDown}
                            maxLength={200}
                          />
                          <div className="message-edit-actions">
                            <button type="button" onClick={saveEditingMessage}>
                              儲存
                            </button>
                            <button type="button" className="secondary" onClick={cancelEditingMessage}>
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p>{message.content}</p>
                      )}
                    </article>
                    {canManageMessage && !isEditing ? (
                      <>
                        <button
                          type="button"
                          className="icon-button message-edit-button"
                          aria-label="管理留言"
                          aria-expanded={isModerating}
                          onClick={() =>
                            setActiveModerationMessageId((current) =>
                              current === message.id ? null : message.id
                            )
                          }
                        >
                          ✎
                        </button>
                        {role === "admin" ? (
                          <div
                            className="message-moderation-actions"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {message.status === "visible" ? (
                              <button onClick={() => moderateMessage(message.id, "hide")}>
                                隱藏
                              </button>
                            ) : message.status === "hidden" ? (
                              <button onClick={() => moderateMessage(message.id, "show")}>
                                顯示
                              </button>
                            ) : null}
                            {canEditMessage ? (
                              <button onClick={() => startEditingMessage(message)}>修改</button>
                            ) : null}
                            <button
                              onClick={() =>
                                moderateMessage(message.id, message.pinned ? "unpin" : "pin")
                              }
                            >
                              {message.pinned ? "取消釘選" : "釘選"}
                            </button>
                            <button
                              className="danger"
                              onClick={() => moderateMessage(message.id, "delete")}
                            >
                              刪除
                            </button>
                          </div>
                        ) : (
                          <div
                            className="message-moderation-actions participant-message-actions"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button onClick={() => startEditingMessage(message)}>修改</button>
                            <button
                              className="danger"
                              onClick={() => moderateMessage(message.id, "delete")}
                            >
                              收回
                            </button>
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="muted chat-empty">尚無問題。</p>
            )}
          </div>
          {onSend ? (
            <div className="chat-footer">
              {chatError ? (
                <div className="chat-error" role="status" aria-live="polite">
                  {chatError.message}
                </div>
              ) : null}
              <form className="chat-form" onSubmit={sendMessage}>
                <textarea
                  ref={chatInputRef}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={handleMessageInputKeyDown}
                  placeholder="輸入問題"
                  maxLength={200}
                />
                <button>送出</button>
              </form>
            </div>
          ) : null}
        </aside>
      ) : null}
      {!isOpen ? (
        <button
          type="button"
          className="floating-chat-toggle"
          aria-controls={panelId}
          aria-expanded={isOpen}
          onClick={() => setIsOpen(true)}
        >
          <span>Q&A</span>
          {unreadCount > 0 ? (
            <span className="floating-chat-badge">{unreadCount >= 99 ? "99+" : unreadCount}</span>
          ) : (
            <small>{visibleMessages.length}</small>
          )}
        </button>
      ) : null}
    </div>
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
  const colors = ["#4b2f8f", "#237355", "#8a631f", "#335f9f", "#9d4d66", "#6f5aa7"];

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

// ─── Alarm worker helper ────────────────────────────────────────────────
const ALARM_WORKER_CODE = `
let timers = [];
self.onmessage = (e) => {
  if (e.data.type === 'schedule') {
    const { id, targetTime, repeatMs } = e.data;
    function check() {
      const now = Date.now();
      if (now >= targetTime) {
        self.postMessage({ type: 'alarm', id });
      } else {
        timers.push(setTimeout(check, repeatMs || 500));
      }
    }
    check();
  }
  if (e.data.type === 'clear') {
    timers.forEach(clearTimeout);
    timers = [];
  }
};
`;

function createAlarmWorker() {
  const blob = new Blob([ALARM_WORKER_CODE], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

// ─── Music player ─────────────────────────────────────────────────────────
type MusicJson = Record<string, string[]>;
let musicJsonCache: MusicJson | null = null;
async function loadMusicJson(): Promise<MusicJson> {
  if (musicJsonCache) return musicJsonCache;
  try {
    const res = await fetch("/music.json");
    musicJsonCache = await res.json();
  } catch {
    musicJsonCache = {};
  }
  return musicJsonCache!;
}



// ─── New message bubble ───────────────────────────────────────────────────
type NewMessageBubble = {
  id: string;
  author: string;
  content: string;
};

function MessageBubbleToast({ bubble, onDone }: { bubble: NewMessageBubble; onDone: () => void }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setFading(true), 3400);
    const doneTimer = window.setTimeout(onDone, 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <div className={`message-bubble-toast${fading ? " fading" : ""}`}>
      <strong>{bubble.author}</strong>
      <span>{bubble.content}</span>
    </div>
  );
}

// ─── Activity waiting page ─────────────────────────────────────────────────
function ActivityWaitingPage({
  activity,
  onStart
}: {
  activity: { type: ActivityType; title: string };
  onStart: () => void;
}) {
  const meta = ACTIVITY_TYPE_META[activity.type];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") onStart();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onStart]);

  return (
    <div className="activity-waiting-page">
      <div className="activity-waiting-badge">
        <div className={`activity-type-icon large ${meta?.className ?? ""}`}>
          {meta ? <img src={meta.icon} alt="" /> : null}
        </div>
        <span>{meta?.label ?? "題目"}</span>
      </div>
      <h2>{activity.title}</h2>
      <p className="muted">按下「開始作答」或 Enter 開始計時</p>
      <button onClick={onStart}>開始作答</button>
    </div>
  );
}

// ─── AdminLivePage ─────────────────────────────────────────────────────────
function AdminLivePage({ liveId }: { liveId: string }) {
  const token = getAdminToken();
  const [state, setState] = useState<LiveState | null>(null);
  const [messages, setMessages] = useState<LiveMessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<{ id: number; message: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMouseActive, setIsMouseActive] = useState(true);
  const [bubbles, setBubbles] = useState<NewMessageBubble[]>([]);
  const [chatIsOpen, setChatIsOpen] = useState(true);
  // Activity waiting: track if we should show the waiting page before starting a timed activity
  const [waitingForActivity, setWaitingForActivity] = useState<{
    timelineItemId: string;
    activity: { type: ActivityType; title: string };
  } | null>(null);

  const musicPlayer = useMemo(() => {
    let audio: HTMLAudioElement | null = null;
    return {
      play: (src: string) => {
        if (audio) { audio.pause(); audio.src = ""; }
        audio = new Audio(src);
        audio.play().catch(() => {});
      },
      stop: () => {
        if (audio) { audio.pause(); audio.src = ""; audio = null; }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alarmWorkerRef = useRef<Worker | null>(null);

  // Alarm worker: set up on mount, schedule alarms from event data
  useEffect(() => {
    const worker = createAlarmWorker();
    alarmWorkerRef.current = worker;
    worker.onmessage = (e) => {
      if (e.data.type === "alarm") {
        const alarmId = e.data.id as string;
        // Find the alarm song
        (async () => {
          if (!state?.event) return;
          // alarms stored in event record (if present)
          const alarms = (state.event as any).alarms as AlarmRecord[] | undefined;
          const alarm = alarms?.find((a) => a.id === alarmId);
          if (alarm?.songFile) {
            musicPlayer.play(`/${alarm.songFile}`);
          }
        })();
      }
    };
    return () => {
      worker.postMessage({ type: "clear" });
      worker.terminate();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Schedule alarms when state loads
  useEffect(() => {
    const worker = alarmWorkerRef.current;
    if (!worker || !state?.event) return;
    const alarms = (state.event as any).alarms as AlarmRecord[] | undefined;
    if (!alarms?.length) return;
    worker.postMessage({ type: "clear" });
    for (const alarm of alarms) {
      if (!alarm.time) continue;
      const [hh, mm] = alarm.time.split(":").map(Number);
      const now = new Date();
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      if (target.getTime() <= Date.now()) continue; // skip past alarms
      worker.postMessage({ type: "schedule", id: alarm.id, targetTime: target.getTime(), repeatMs: 500 });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.event]);
  const chatErrorIdRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const qrDialogRef = useRef<HTMLDialogElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const mouseActiveTimerRef = useRef<number | null>(null);
  const knownMessageIdsRef = useRef<Set<string> | null>(null);
  const prevActivityIdRef = useRef<string | null>(null);
  const prevTimeLimitRef = useRef<number>(0);

  const joinCode = state?.liveSession.joinCode ?? "";
  const joinUrl = useMemo(() => {
    if (!joinCode) return "";
    const url = new URL("/", window.location.origin);
    url.searchParams.set("joinCode", joinCode);
    return url.toString();
  }, [joinCode]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      musicPlayer.stop();
    };
  }, [musicPlayer]);

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
    if (dialog.open) return;
    dialog.showModal();
  }, []);

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
    knownMessageIdsRef.current = new Set(loadedMessages.map((m) => m.id));
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
      const msg = (message.payload as any).message as LiveMessageRecord;
      setMessages((current) => mergeMessage(current, msg));
      // Show bubble if chat is not open or fullscreen
      const known = knownMessageIdsRef.current;
      if (known && !known.has(msg.id)) {
        setBubbles((prev) => [
          ...prev.slice(-2),
          { id: msg.id, author: msg.participantName ?? "匿名", content: msg.content }
        ]);
        known.add(msg.id);
      }
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

  const showChatError = useCallback((message: string) => {
    chatErrorIdRef.current += 1;
    setChatError({ id: chatErrorIdRef.current, message });
  }, []);
  const dismissChatError = useCallback(() => setChatError(null), []);

  const socket = useLiveSocket({
    liveId,
    role: "admin",
    token,
    onMessage: handleMessage,
    onError: showChatError
  });

  const remaining = useServerCountdown(state);
  const timeline = state?.timeline ?? [];
  const currentTimelineItem = state?.currentTimelineItem ?? null;
  const currentIndex = timeline.findIndex((item) => item.id === currentTimelineItem?.id);
  const previousTimelineItem = timeline[currentIndex - 1];
  const nextTimelineItem = timeline[currentIndex + 1];
  const presentationFileUrl = useMemo(() => {
    if (!state?.presentation || !token) return "";
    const versionParam = encodeURIComponent(`${state.presentation.id}-${state.presentation.updatedAt}`);
    return `/api/events/${state.event.id}/presentation/file?token=${encodeURIComponent(token)}&v=${versionParam}`;
  }, [state?.event.id, state?.presentation, token]);
  const isPdfPage = currentTimelineItem?.type === "pdf_page";
  const isWordCloudActivity = state?.currentActivity?.type === "word_cloud";
  const hasCurrentActivity = Boolean(state?.currentActivity);
  const activityOpen = Boolean(state?.activityOpen);
  const answerClosed = Boolean(state?.answerClosed);
  const isTimedActivity = (state?.currentActivity?.timeLimitSeconds ?? 0) > 0;

  // Activity change: detect transition and show waiting page for timed activities
  useEffect(() => {
    const currentActivity = state?.currentActivity;
    const currentActivityId = currentActivity?.id ?? null;
    const currentTimeLimit = currentActivity?.timeLimitSeconds ?? 0;
    const prevActivityId = prevActivityIdRef.current;

    if (currentActivityId && currentActivityId !== prevActivityId) {
      // New activity loaded
      const prevItem = prevActivityId;
      const prevWasPdf = !prevItem; // simplified: if no previous activity, treat as fresh start
      const prevTimelineIndex = currentIndex - 1;
      const prevItem2 = timeline[prevTimelineIndex];
      const prevWasPdfOrNoActivity = !prevItem2 || prevItem2.type === "pdf_page";

      if (currentTimeLimit > 0 && prevWasPdfOrNoActivity && !activityOpen) {
        // Show waiting page
        setWaitingForActivity({
          timelineItemId: currentTimelineItem?.id ?? "",
          activity: { type: currentActivity!.type, title: currentActivity!.title }
        });
      } else {
        setWaitingForActivity(null);
      }
    }
    if (!currentActivityId) {
      setWaitingForActivity(null);
    }
    prevActivityIdRef.current = currentActivityId;
    prevTimeLimitRef.current = currentTimeLimit;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.currentActivity?.id]);

  // Music: play game music when timed activity starts
  useEffect(() => {
    if (activityOpen && isTimedActivity) {
      loadMusicJson().then((music) => {
        const gameSongs = music["game"] ?? [];
        if (gameSongs.length) {
          const song = gameSongs[Math.floor(Math.random() * gameSongs.length)];
          musicPlayer.play(`/${song}`);
        }
      });
    } else {
      // Stop music when time's up or activity not open
      if (!activityOpen || remaining === 0) {
        musicPlayer.stop();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityOpen, isTimedActivity]);

  useEffect(() => {
    if (remaining === 0) musicPlayer.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  // Hotkeys for navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire if user is typing
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const isEditable = (e.target as HTMLElement)?.isContentEditable;
      if (isEditable) return;

      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
        if (previousTimelineItem && socket.connected) {
          socket.send("change_timeline_item", { timelineItemId: previousTimelineItem.id });
        }
      }
      if (["ArrowRight", "ArrowDown", "PageDown"].includes(e.key)) {
        if (nextTimelineItem && socket.connected) {
          socket.send("change_timeline_item", { timelineItemId: nextTimelineItem.id });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previousTimelineItem, nextTimelineItem, socket]);

  // Fullscreen mouse-hide
  useEffect(() => {
    if (!isFullscreen) return;
    const handleMove = () => {
      setIsMouseActive(true);
      if (mouseActiveTimerRef.current) window.clearTimeout(mouseActiveTimerRef.current);
      mouseActiveTimerRef.current = window.setTimeout(() => setIsMouseActive(false), 3000);
    };
    window.addEventListener("mousemove", handleMove);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      if (mouseActiveTimerRef.current) window.clearTimeout(mouseActiveTimerRef.current);
    };
  }, [isFullscreen]);

  // Fullscreen API
  const enterFullscreen = useCallback(() => {
    const el = fullscreenContainerRef.current;
    if (el?.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
    setIsFullscreen(true);
    setIsMouseActive(true);
  }, []);

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setIsFullscreen(false);
  }, []);

  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Open new window for fullscreen on another screen
  const openFullscreenWindow = useCallback(() => {
    const w = window.open(
      `/admin/live/${liveId}/fullscreen`,
      "slihoot-presentation",
      "width=1280,height=720,toolbar=no,menubar=no,scrollbars=no"
    );
    if (!w) return;
    // Pass current state via postMessage after window loads
    const onLoad = () => {
      w.postMessage({ type: "init_fullscreen", liveId, token }, "*");
    };
    w.addEventListener("load", onLoad, { once: true });
  }, [liveId, token]);

  async function endLive() {
    if (!token || !confirm("結束這場活動？")) return;
    try {
      await api<LiveSessionRecord>(`/api/live-sessions/${liveId}/end`, {
        method: "POST",
        adminToken: token
      });
      navigate("/admin/dashboard");
    } catch (error) {
      setError(error instanceof Error ? error.message : "結束活動失敗");
    }
  }

  async function resetActivity() {
    if (!token || !state?.currentActivity) return;
    if (!confirm("重置這題？計時將重新開始，所有作答紀錄將清除。")) return;
    try {
      await api(`/api/live-sessions/${liveId}/reset-activity`, {
        method: "POST",
        adminToken: token
      });
      musicPlayer.stop();
    } catch (error) {
      setError(error instanceof Error ? error.message : "重置失敗");
    }
  }

  async function downloadExport(format: "xlsx" | "json" | "csv") {
    const eventId = state?.event.id;
    if (!token || !eventId) return;
    try {
      const response = await fetch(`/api/events/${eventId}/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`匯出失敗（${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `slihoot-event-${eventId}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : "匯出失敗");
    }
  }

  function handleStartActivity() {
    setWaitingForActivity(null);
    socket.send("start_activity", {});
    // Start music
    loadMusicJson().then((music) => {
      const gameSongs = music["game"] ?? [];
      if (gameSongs.length) {
        const song = gameSongs[Math.floor(Math.random() * gameSongs.length)];
        musicPlayer.play(`/${song}`);
      }
    });
  }

  const stagePart = (
    <div className="question-block">
      <small>
        {currentIndex >= 0 ? currentIndex + 1 : 0} / {timeline.length}
      </small>
      {isPdfPage ? (
        <>
          <PdfCanvasPage
            className="presentation-stage"
            url={presentationFileUrl}
            pageNumber={currentTimelineItem?.pageNumber}
            style={presentationStageStyle(state?.presentation, currentTimelineItem?.pageNumber)}
          />
        </>
      ) : waitingForActivity && !activityOpen ? (
        <ActivityWaitingPage
          activity={waitingForActivity.activity}
          onStart={handleStartActivity}
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  );

  const controlPart = (
    <div className="button-row">
      {hasCurrentActivity && !activityOpen && !waitingForActivity ? (
        <button
          disabled={!socket.connected}
          title={!socket.connected ? "連線中，請稍候" : undefined}
          onClick={() => socket.send("start_activity", {})}
        >
          開始答題
        </button>
      ) : null}
      <button
        disabled={!previousTimelineItem || !socket.connected}
        onClick={() =>
          previousTimelineItem &&
          socket.send("change_timeline_item", { timelineItemId: previousTimelineItem.id })
        }
      >
        上一頁
      </button>
      <button
        disabled={!nextTimelineItem || !socket.connected}
        onClick={() =>
          nextTimelineItem &&
          socket.send("change_timeline_item", { timelineItemId: nextTimelineItem.id })
        }
      >
        下一頁
      </button>
      <button
        hidden={!hasCurrentActivity || isWordCloudActivity || isTimedActivity}
        disabled={!socket.connected || Boolean(state?.liveSession.showResults)}
        title={
          !socket.connected
            ? "連線中，請稍候"
            : state?.liveSession.showResults
              ? "答案已公布，本題作答已結束"
              : "公布答案並結束本題作答"
        }
        onClick={() => socket.send("set_results_visibility", { showResults: true })}
      >
        公布答案
      </button>
      <button
        hidden={!hasCurrentActivity || isWordCloudActivity}
        disabled={!socket.connected}
        onClick={() =>
          socket.send("set_participant_name_visibility", {
            showParticipantNames: !state?.liveSession.showParticipantNames
          })
        }
      >
        {state?.liveSession.showParticipantNames ? "匿名明細" : "記名明細"}
      </button>
      {hasCurrentActivity ? (
        <button
          className="secondary"
          title="重置這題的計時和作答"
          onClick={resetActivity}
        >
          重置
        </button>
      ) : null}
      <button className="danger" onClick={endLive}>
        結束
      </button>
    </div>
  );

  return (
    <AdminGuard>
      <Header
        title="主持畫面"
        actions={
          <>
            <button className="secondary icon-button" title="進入全螢幕" onClick={enterFullscreen}>⛶</button>
            <button className="secondary icon-button" title="在新視窗開啟展示" onClick={openFullscreenWindow}>⊹</button>
            <button onClick={() => navigate("/admin/dashboard")}>回列表</button>
          </>
        }
      />
      <main className="page live-layout">
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

        {/* Fullscreen overlay */}
        <div
          ref={fullscreenContainerRef}
          className={`fullscreen-container${isFullscreen ? " is-fullscreen" : ""}${isFullscreen && !isMouseActive ? " hide-controls" : ""}`}
        >
          {isFullscreen ? (
            <>
              <div className="fullscreen-stage">
                {isPdfPage ? (
                  <PdfCanvasPage
                    className="presentation-stage fullscreen-pdf"
                    url={presentationFileUrl}
                    pageNumber={currentTimelineItem?.pageNumber}
                    style={{ width: "100%", height: "100%", maxHeight: "none", borderRadius: 0 }}
                  />
                ) : waitingForActivity && !activityOpen ? (
                  <ActivityWaitingPage
                    activity={waitingForActivity.activity}
                    onStart={handleStartActivity}
                  />
                ) : (
                  <div className="fullscreen-activity">
                    <h2>{state?.currentActivity?.title ?? "等待中"}</h2>
                    {state?.currentActivity?.description ? <p>{state.currentActivity.description}</p> : null}
                    {answerClosed ? (
                      <div className="countdown ended">已結束作答</div>
                    ) : remaining !== null ? (
                      <div className={`countdown${remaining === 0 ? " ended" : ""}`}>
                        {remaining === 0 ? "時間到" : `剩餘 ${remaining} 秒`}
                      </div>
                    ) : null}
                    {hasCurrentActivity && (state?.liveSession.showResults || answerClosed) ? (
                      <div className="fullscreen-results">
                        <SummaryView summary={state?.responseSummary ?? null} />
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="fullscreen-controls">
                <div className="fullscreen-status">
                  <span className={socket.connected ? "status online" : "status"} />
                  <strong>{joinCode}</strong>
                  <span>{state?.participantCount ?? 0} 人</span>
                  <span>{currentIndex + 1} / {timeline.length}</span>
                </div>
                <div className="fullscreen-buttons">
                  {hasCurrentActivity && !activityOpen && !waitingForActivity ? (
                    <button onClick={() => socket.send("start_activity", {})}>開始答題</button>
                  ) : null}
                  <button
                    disabled={!previousTimelineItem || !socket.connected}
                    onClick={() => previousTimelineItem && socket.send("change_timeline_item", { timelineItemId: previousTimelineItem.id })}
                  >上一頁</button>
                  <button
                    disabled={!nextTimelineItem || !socket.connected}
                    onClick={() => nextTimelineItem && socket.send("change_timeline_item", { timelineItemId: nextTimelineItem.id })}
                  >下一頁</button>
                  <button className="secondary" onClick={exitFullscreen}>離開全螢幕</button>
                </div>
              </div>
              {/* Bubbles in fullscreen */}
              <div className="bubble-toast-stack">
                {bubbles.map((b) => (
                  <MessageBubbleToast
                    key={b.id}
                    bubble={b}
                    onDone={() => setBubbles((prev) => prev.filter((x) => x.id !== b.id))}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>

        {/* Normal live page */}
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
          {stagePart}
          {controlPart}
          {!socket.connected ? (
            <p className="muted">連線中，請稍候再操作...</p>
          ) : null}
          {hasCurrentActivity ? (
            <section className="results-panel">
              <h2>即時結果</h2>
              <SummaryView summary={state?.responseSummary ?? null} />
            </section>
          ) : null}
          <Leaderboard entries={state?.leaderboard} />
          <section className="results-panel">
            <h2>匯出歷史數據</h2>
            <div className="button-row">
              <button type="button" onClick={() => downloadExport("xlsx")}>
                匯出 Excel
              </button>
              <button type="button" className="secondary" onClick={() => downloadExport("json")}>
                匯出 JSON
              </button>
              <button type="button" className="secondary" onClick={() => downloadExport("csv")}>
                匯出 CSV
              </button>
            </div>
            <p className="muted">包含這個活動所有場次的作答紀錄、答對與分數。</p>
          </section>
        </section>

        {/* Bubble toasts (non-fullscreen) */}
        <div className="bubble-toast-stack">
          {!isFullscreen && bubbles.map((b) => (
            <MessageBubbleToast
              key={b.id}
              bubble={b}
              onDone={() => setBubbles((prev) => prev.filter((x) => x.id !== b.id))}
            />
          ))}
        </div>

        <ChatPanel
          role="admin"
          messages={messages}
          chatError={chatError}
          onChatErrorDismiss={dismissChatError}
          onChatOpenChange={setChatIsOpen}
          onSend={(content) => socket.send("send_message", { content })}
          onModerate={(messageId, action, content) =>
            socket.send("moderate_message", { messageId, action, content })
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
  submittedOrder,
  onSubmit
}: {
  activity: ActivityRecord;
  disabled: boolean;
  revealed: boolean;
  submittedOptionId?: string;
  submittedText?: string;
  submittedOrder?: string[];
  onSubmit: (answer: unknown) => boolean | void;
}) {
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [order, setOrder] = useState<string[]>([]);
  const correctId = correctOptionId(activity.correctAnswer);

  useEffect(() => {
    setSelected(submittedOptionId);
    setText(submittedText);
    // Use the participant's submitted order if any, else the (server-scrambled)
    // option order they were shown.
    setOrder(
      submittedOrder && submittedOrder.length
        ? submittedOrder
        : activity.options.map((option) => option.id)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  if (activity.type === "ranking") {
    const orderedItems = order
      .map((optionId) => activity.options.find((option) => option.id === optionId))
      .filter((option): option is ActivityOption => Boolean(option));
    return (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ order });
        }}
      >
        {!disabled ? <p className="muted">拖曳方塊調整順序</p> : null}
        <SortableList
          items={orderedItems}
          disabled={disabled}
          onReorder={(orderedIds) => setOrder(orderedIds)}
          renderItem={(option) => <span className="name">{option.label}</span>}
        />
        <button disabled={disabled}>{disabled ? "已送出" : "送出排序"}</button>
      </form>
    );
  }

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
  const [chatError, setChatError] = useState<{ id: number; message: string } | null>(null);
  const chatErrorIdRef = useRef(0);
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
      if (payload.message) {
        setMessages((current) =>
          mergeMessage(current, payload.message).filter((candidate) => candidate.status === "visible")
        );
        return;
      }
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

  const showChatError = useCallback((message: string) => {
    chatErrorIdRef.current += 1;
    setChatError({ id: chatErrorIdRef.current, message });
  }, []);
  const dismissChatError = useCallback(() => setChatError(null), []);

  const socket = useLiveSocket({
    liveId,
    role: "participant",
    token: participantToken,
    onMessage: handleMessage,
    onError: showChatError
  });

  const currentActivity = state?.currentActivity ?? null;
  const wordCloudRepeatAllowed =
    currentActivity?.type === "word_cloud" ? Boolean(currentActivity.allowRepeatAnswers) : false;
  const answerLocked =
    Boolean(localResponse) &&
    (currentActivity?.type !== "word_cloud" || !wordCloudRepeatAllowed);
  const myAnswer = (localResponse?.answer ?? state?.myResponse?.answer) as
    | { optionId?: unknown; text?: unknown; order?: unknown }
    | undefined;
  const submittedOptionId =
    myAnswer && typeof myAnswer === "object" ? String(myAnswer.optionId ?? "") : "";
  const submittedText =
    myAnswer && typeof myAnswer === "object" ? String(myAnswer.text ?? "") : "";
  const submittedOrder =
    myAnswer && Array.isArray(myAnswer.order) ? myAnswer.order.map((value) => String(value)) : undefined;
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
      <>
      <Header title="活動" />
      <main className="page narrow">
        <ErrorBanner message={error} />
        <button onClick={() => navigate("/")}>重新加入</button>
      </main>
      </>
    );
  }

  if (state?.liveSession.status === "ended") {
    return (
      <>
      <Header title={state.event.title} />
      <main className="page narrow">
        <ErrorBanner message={error} />
        <section className="panel form-stack">
          <h2>活動已結束</h2>
          <p className="muted">主持人已結束這場活動。</p>
          <button
            onClick={() => {
              localStorage.removeItem(PARTICIPANT_TOKEN_KEY);
              localStorage.removeItem(PARTICIPANT_LIVE_KEY);
              navigate("/");
            }}
          >
            回首頁
          </button>
        </section>
      </main>
      </>
    );
  }

  return (
    <>
    <Header title={state?.event.title ?? "活動中"} actions={<button onClick={() => navigate("/")}>首頁</button>} />
    <main className="page live-layout participant">
      {error ? (
        <div className="error-stack">
          <ErrorBanner message={error} />
        </div>
      ) : null}
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
                state?.liveSession.status !== "active" ||
                (currentActivity.type === "word_cloud" ? answerLocked || timeUp : answerLocked || timeUp)
              }
              revealed={revealed}
              submittedOptionId={submittedOptionId}
              submittedText={submittedText}
              submittedOrder={submittedOrder}
              onSubmit={(answer) => {
                const sent = socket.send("submit_answer", {
                  activityId: currentActivity.id,
                  answer
                });
                if (sent && (currentActivity.type !== "word_cloud" || !wordCloudRepeatAllowed)) {
                  setLocalResponse({} as ResponseRecord);
                }
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
            {revealed && state?.myRank ? (
              <p className="my-score">
                你的分數 <strong>{state.myScore ?? 0}</strong> 分 · 目前第 {state.myRank} 名
              </p>
            ) : null}
            {revealed ? <Leaderboard entries={state?.leaderboard} meId={state?.me?.id} /> : null}
          </>
        ) : state?.liveSession.currentActivityId ? (
          <p className="muted">主持人即將開始這一題，請稍候…</p>
        ) : (
          <p className="muted">請看主持人畫面，等待下一個可作答題目。</p>
        )}
      </section>
      <ChatPanel
        role="participant"
        messages={sortedMessages}
        currentParticipantId={state?.me?.id}
        chatError={chatError}
        onChatErrorDismiss={dismissChatError}
        onSend={(content) => socket.send("send_message", { content })}
        onModerate={(messageId, action, content) =>
          socket.send("moderate_message", { messageId, action, content })
        }
      />
    </main>
    </>
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