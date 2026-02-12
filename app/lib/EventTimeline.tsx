"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

type EventRow = {
  id: string;
  request_id: string;
  type: string;
  message: string | null;
  actor: string | null;
  created_at: string;
};

function formatTimeKST(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function actorLabel(actor: string | null) {
  if (actor === "requester") return "requester";
  if (actor === "participant") return "participant";
  if (actor === "system") return "system";
  return actor ?? "-";
}

function actorBadgeClass(actor: string | null) {
  // 🟡 2) actor별 색상 (CSS class)
  if (actor === "requester") return "bg-blue-50 text-blue-700 border-blue-200";
  if (actor === "participant") return "bg-green-50 text-green-700 border-green-200";
  if (actor === "system") return "bg-gray-50 text-gray-700 border-gray-200";
  return "bg-white text-gray-700 border-gray-200";
}

export default function EventTimeline({ requestId }: { requestId: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const channelName = useMemo(() => `events:${requestId}`, [requestId]);

  const fetchEvents = async () => {
    if (!requestId) return;
    setErr("");

    const { data, error } = await supabase
      .from("events")
      .select("id,request_id,type,message,actor,created_at")
      .eq("request_id", requestId)
      .order("created_at", { ascending: true });

    if (error) {
      setErr(error.message);
      return;
    }

    setEvents((data as EventRow[]) ?? []);
  };

  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoading(true);
      await fetchEvents();
      if (mounted) setLoading(false);
    })();

    // 🔴 Realtime 구독: events 테이블에서 request_id=해당 건만
    const ch = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "events",
          filter: `request_id=eq.${requestId}`,
        },
        () => {
          // 이벤트 한 번 들어올 때마다 다시 조회 (데모 안정성 최고)
          fetchEvents();
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, channelName]);

  return (
    <div className="mt-6 rounded-2xl border bg-white p-4">
      <div className="font-semibold mb-3">이동 기록</div>

      {loading && <div className="text-sm text-gray-400">불러오는 중…</div>}
      {err && <div className="text-sm text-red-600">{err}</div>}

      {!loading && !err && events.length === 0 && (
        <div className="text-sm text-gray-400">아직 기록이 없습니다.</div>
      )}

      <div className="space-y-3">
        {events.map((e) => (
          <div key={e.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${actorBadgeClass(e.actor)}`}>
                  {actorLabel(e.actor)}
                </span>
                <span className="font-medium">{e.type}</span>
              </div>
              {e.message && <div className="text-sm text-gray-600 mt-1">{e.message}</div>}
            </div>
            <div className="text-xs text-gray-400 whitespace-nowrap">{formatTimeKST(e.created_at)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
