import { supabase } from "./supabaseClient";

export async function logEvent(params: {
  requestId: string;
  type: string;
  message?: string;
  actor?: string; // requester | participant | system
}) {
  const { requestId, type, message = null, actor = null } = params;

  if (!requestId) return;

  const { error } = await supabase.from("events").insert({
    request_id: requestId,
    type,
    message,
    actor,
  });

  if (error) {
    console.error("[logEvent] insert failed:", error.message);
  }
}
