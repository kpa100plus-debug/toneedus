import { supabase } from "./supabaseClient";

export async function addEvent(params: {
  request_id: string;
  type: string;
  message?: string;
  actor?: string;
}) {
  const { request_id, type, message, actor } = params;

  const { error } = await supabase.from("events").insert({
    request_id,
    type,
    message: message ?? null,
    actor: actor ?? null,
  });

  // 데모에서는 이벤트 실패가 전체 흐름을 막지 않게(조용히 로그만)
  if (error) {
    console.warn("addEvent failed:", error.message);
  }
}
