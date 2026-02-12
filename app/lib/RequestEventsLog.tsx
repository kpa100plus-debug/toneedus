"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

type EventRow = {
  id: number;
  request_id: string;
  ts: string;
  event_type: string;
  actor: string | null;
  message: string | null;
};

export default function RequestEventsLog({
  requestId,
  title = "이벤트 로그",
}: {
  requestId: string;
  title?: string;
}) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [err, setErr] = useState<string>("");

  const loadEvents = async () => {
    if (!requestId) return;

    const { data, error } = await supabase
      .from("request_events")
      .select("id, request_id, ts, event_type, actor, message")
      .eq("request_id", requestId)
      .order("ts", { ascending: false })
      .limit(50);

    if (error) {
      setErr(error.message);
      return;
    }
    setErr("");
    setEvents((data ?? []) as EventRow[]);
  };

  useEffect(() => {
    if (!requestId) return;

    // 1) 최초 로드
    loadEvents();

    // 2) Realtime 구독 (request_events 변화 감지)
    const ch = supabase
      .channel(`request_events_${requestId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "request_events",
          filter: `request_id=eq.${requestId}`,
        },
        () => {
          loadEvents();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  return (
    <div className="rounded-2xl border bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-gray-500">{title}</div>
        <button
          onClick={loadEvents}
          className="text-xs text-gray-600 underline"
        >
          새로고침
        </button>
      </div>

      {err && (
        <div className="mb-2 text-sm text-red-600">
          이벤트 로드 오류: {err}
        </div>
      )}

      {events.length === 0 ? (
        <div className="rounded-xl border p-4 text-sm text-gray-400">
          아직 기록이 없습니다.
        </div>
      ) : (
        <ul className="space-y-2 text-sm">
          {events.map((ev) => (
            <li key={ev.id} className="border-b pb-2">
              <div className="text-[11px] text-gray-400">
                {new Date(ev.ts).toLocaleString()} · {ev.actor ?? "system"}
              </div>
              <div className="font-medium">{ev.message ?? "-"}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
