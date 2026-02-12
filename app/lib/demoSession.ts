export type DemoStatus =
  | "idle"
  | "broadcasted"
  | "accepted"
  | "in_progress"
  | "arrived"
  | "completed"
  | "cancelled";

export type DemoSession = {
  id: string; // 고정 세션
  status: DemoStatus;
  logs: string[];
  updatedAt: number;
};

const KEY = "bbcop_demo_session_v1";
const DEFAULT: DemoSession = {
  id: "session-1",
  status: "idle",
  logs: ["00:00 데모 준비 완료"],
  updatedAt: Date.now(),
};

export function loadSession(): DemoSession {
  if (typeof window === "undefined") return DEFAULT;
  const raw = localStorage.getItem(KEY);
  if (!raw) {
    localStorage.setItem(KEY, JSON.stringify(DEFAULT));
    return DEFAULT;
  }
  try {
    return JSON.parse(raw) as DemoSession;
  } catch {
    localStorage.setItem(KEY, JSON.stringify(DEFAULT));
    return DEFAULT;
  }
}

export function saveSession(next: DemoSession) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify({ ...next, updatedAt: Date.now() }));
}

export function addLog(s: DemoSession, line: string): DemoSession {
  return { ...s, logs: [...s.logs, line] };
}

export function resetSession() {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(DEFAULT));
}
