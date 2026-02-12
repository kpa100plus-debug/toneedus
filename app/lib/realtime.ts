import { supabase } from "./supabaseClient";

/**
 * requests 테이블: 특정 request_id 1건의 변경을 실시간으로 감지
 */
export function subscribeRequest(requestId: string, onChange: () => void) {
  const ch = supabase
    .channel(`realtime:requests:${requestId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "requests",
        filter: `id=eq.${requestId}`,
      },
      () => onChange()
    )
    .subscribe();

  return () => {
    supabase.removeChannel(ch);
  };
}

/**
 * events 테이블: 특정 request_id의 이벤트 추가/변경을 실시간 감지
 */
export function subscribeEvents(requestId: string, onChange: () => void) {
  const ch = supabase
    .channel(`realtime:events:${requestId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "events",
        filter: `request_id=eq.${requestId}`,
      },
      () => onChange()
    )
    .subscribe();

  return () => {
    supabase.removeChannel(ch);
  };
}

/**
 * participant 화면: broadcasted 요청 목록이 변하면 갱신
 * (단순하게 전체 변경을 감지하고 loadRequests() 다시 호출하는 방식)
 */
export function subscribeRequestsAny(onChange: () => void) {
  const ch = supabase
    .channel(`realtime:requests:any`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "requests" },
      () => onChange()
    )
    .subscribe();

  return () => {
    supabase.removeChannel(ch);
  };
}
