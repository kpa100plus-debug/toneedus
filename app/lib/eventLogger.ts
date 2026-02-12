import { supabase } from "./supabaseClient";

export type EventRow = {
  id: string;
  request_id: string;
  type: string;
  message: string;
  actor: string;
  created_at: string;
};

// 이벤트 추가
export async function logEvent(
  requestId: string,
  type: string,
  message: string,
  actor: string
) {
  const { error } = await supabase.from("events").insert({
    request_id: requestId,
    type,
    message,
    actor,
  });

  if (error) throw error;
}

// 특정 요청의 이벤트 목록 조회
export async function fetchEvents(requestId: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as EventRow[];
}
