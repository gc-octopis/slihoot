export const ADMIN_TOKEN_KEY = "slihoot_admin_token";
export const PARTICIPANT_TOKEN_KEY = "slihoot_participant_token";
export const PARTICIPANT_LIVE_KEY = "slihoot_participant_live_id";

interface RequestOptions {
  method?: string;
  body?: unknown;
  adminToken?: string | null;
  participantToken?: string | null;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (options.adminToken) {
    headers.Authorization = `Bearer ${options.adminToken}`;
  }

  if (options.participantToken) {
    headers["X-Participant-Token"] = options.participantToken;
  }

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed.", response.status);
  }

  return data as T;
}

export function getAdminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string) {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export function saveParticipantSession(liveId: string, participantToken: string) {
  localStorage.setItem(PARTICIPANT_LIVE_KEY, liveId);
  localStorage.setItem(PARTICIPANT_TOKEN_KEY, participantToken);
}

export function getParticipantSession() {
  return {
    liveId: localStorage.getItem(PARTICIPANT_LIVE_KEY),
    participantToken: localStorage.getItem(PARTICIPANT_TOKEN_KEY)
  };
}

