export type ActivityType =
  | "multiple_choice"
  | "true_false"
  | "short_answer"
  | "word_cloud"
  | "ranking";
export type LiveStatus = "waiting" | "active" | "ended";
export type MessageStatus = "visible" | "hidden" | "deleted";
export type TimelineItemType = "pdf_page" | "activity";

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityOption {
  id: string;
  label: string;
}

export interface ActivityRecord {
  id: string;
  eventId: string;
  type: ActivityType;
  title: string;
  description: string;
  explanation: string;
  timeLimitSeconds: number;
  options: ActivityOption[];
  correctAnswer: unknown;
  allowRepeatAnswers?: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventPresentationRecord {
  id: string;
  eventId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  fileSize: number;
  pageCount: number;
  pageSizes: Array<{
    width: number;
    height: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineItemRecord {
  id: string;
  eventId: string;
  type: TimelineItemType;
  activityId: string | null;
  presentationId: string | null;
  pageNumber: number | null;
  sortOrder: number;
  activity?: ActivityRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveLiveSessionSummary {
  id: string;
  joinCode: string;
  status: LiveStatus;
  participantCount: number;
  startedAt: string | null;
}

export interface LiveSessionRecord {
  id: string;
  eventId: string;
  joinCode: string;
  status: LiveStatus;
  currentTimelineItemId: string | null;
  currentTimelineIndex: number;
  currentActivityId: string | null;
  currentActivityIndex: number;
  currentActivityStartedAt: string | null;
  completedActivityIds: string[];
  showResults: boolean;
  showParticipantNames: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantRecord {
  id: string;
  liveSessionId: string;
  nickname: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface ResponseRecord {
  id: string;
  liveSessionId: string;
  activityId: string;
  participantId: string;
  answer: unknown;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiveMessageRecord {
  id: string;
  liveSessionId: string;
  participantId: string | null;
  participantName: string;
  content: string;
  status: MessageStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  moderatedAt: string | null;
}

export interface ResponseSummary {
  type: ActivityType;
  total: number;
  correctAnswerText?: string;
  correctOrder?: Array<{ number: number; label: string }>;
  correctCount?: number;
  options?: Array<ActivityOption & { count: number; percent: number; isCorrect?: boolean }>;
  words?: Array<{
    text: string;
    count: number;
    percent: number;
    weight: number;
  }>;
  responses?: Array<{
    participantName: string | null;
    answerLabel?: string;
    optionId?: string;
    text?: string;
    isCorrect?: boolean | null;
    receivedAt: string;
  }>;
}

export interface LeaderboardEntry {
  participantId: string;
  nickname: string;
  score: number;
  answers: number;
  rank: number;
}

export interface LiveState {
  liveSession: LiveSessionRecord;
  event: EventRecord;
  activities?: ActivityRecord[];
  timeline?: TimelineItemRecord[];
  presentation?: EventPresentationRecord | null;
  currentTimelineItem: TimelineItemRecord | null;
  currentActivity: ActivityRecord | null;
  participantCount: number;
  responseSummary: ResponseSummary | null;
  serverNow: string;
  answerRevealed: boolean;
  answerClosed: boolean;
  activityOpen: boolean;
  leaderboard?: LeaderboardEntry[];
  myScore?: number;
  myRank?: number | null;
  me?: ParticipantRecord | null;
  myResponse?: ResponseRecord | null;
}

export interface SocketMessage<T = unknown> {
  type: string;
  payload: T;
}
