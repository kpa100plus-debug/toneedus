"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";

type Req = {
  id: string;
  status: string;
  pickup_text: string | null;
  dropoff_text: string | null;
  requester_label: string | null;
  participant_label: string | null;
  created_at?: string | null;

  pickup_lat?: number | null;
  pickup_lng?: number | null;
  participant_lat?: number | null;
  participant_lng?: number | null;
};

export default function ParticipantPage() {
  const router = useRouter();
  const [list, setList] = useState<Req[]>([]);
  const [msg, setMsg] = useState<string>("");

  const loadList = async () => {
    const { data, error } = await supabase
      .from("requests")
      .select(
        "id,status,pickup_text,dropoff_text,requester_label,participant_label,created_at,pickup_lat,pickup_lng,participant_lat,participant_lng"
      )
      .in("status", ["broadcasted", "accepted", "in_trip", "arrived"])
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      setMsg("목록 로드 오류: " + error.message);
      return;
    }
    setList((data ?? []) as any);
  };

  const goTrip = (id: string) => {
    router.push(`/participant/trip?id=${id}`);
  };

  const accept = async (requestId: string) => {
    const { error } = await supabase
      .from("requests")
      .update({
        status: "accepted",
        participant_label: "참여자",
      })
      .eq("id", requestId);

    if (error) {
      setMsg("수락 오류: " + error.message);
      return;
    }

    setMsg("수락 완료 ✅  실시간 지도 화면으로 이동합니다.");
    await loadList();
    goTrip(requestId);
  };

  const startTrip = async (requestId: string) => {
    const { error } = await supabase
      .from("requests")
      .update({
        status: "in_trip",
        participant_label: "참여자",
      })
      .eq("id", requestId);

    if (error) {
      setMsg("동행 시작 오류: " + error.message);
      return;
    }

    setMsg("동행 시작 ✅  실시간 지도 화면으로 이동합니다.");
    await loadList();
    goTrip(requestId);
  };

  const arrive = async (requestId: string) => {
    const { error } = await supabase.from("requests").update({ status: "arrived" }).eq("id", requestId);
    if (error) {
      setMsg("도착 처리 오류: " + error.message);
      return;
    }
    setMsg("도착 처리 ✅");
    await loadList();
    goTrip(requestId);
  };

  const completeTrip = async (requestId: string) => {
    const { error } = await supabase.from("requests").update({ status: "completed" }).eq("id", requestId);
    if (error) {
      setMsg("종료 처리 오류: " + error.message);
      return;
    }
    setMsg("동행 종료 ✅");
    await loadList();
  };

  useEffect(() => {
    loadList();
  }, []);

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">동행 참여 (참여자)</h1>
        <Link href="/" className="text-sm text-gray-600 underline">
          홈으로
        </Link>
      </div>

      {msg && <div className="p-3 rounded-xl border bg-white text-sm mb-4">{msg}</div>}

      <div className="max-w-md space-y-4">
        <div className="rounded-2xl border bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500">요청 목록</div>
            <button onClick={loadList} className="text-xs px-3 py-1 rounded-lg border bg-white">
              새로고침
            </button>
          </div>

          {list.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">현재 대기/진행 중인 요청이 없습니다.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {list.map((r) => {
                const canArrive = r.status === "in_trip";
                const canComplete = r.status === "in_trip" || r.status === "arrived";

                return (
                  <li key={r.id} className="border rounded-xl p-3 bg-gray-50">
                    <div className="text-xs text-gray-500">status: {r.status}</div>
                    <div className="font-mono text-xs break-all mt-1">{r.id}</div>
                    <div className="text-sm mt-2">출발: {r.pickup_text ?? "-"}</div>
                    <div className="text-sm">도착: {r.dropoff_text ?? "-"}</div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {r.status === "broadcasted" && (
                        <button
                          onClick={() => accept(r.id)}
                          className="col-span-2 px-4 py-2 rounded-xl bg-green-600 text-white text-sm"
                        >
                          요청 수락
                        </button>
                      )}

                      {r.status === "accepted" && (
                        <button
                          onClick={() => startTrip(r.id)}
                          className="col-span-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm"
                        >
                          동행 시작
                        </button>
                      )}

                      {(r.status === "in_trip" || r.status === "arrived") && (
                        <>
                          <button
                            onClick={() => arrive(r.id)}
                            className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm disabled:opacity-50"
                            disabled={!canArrive}
                            title={!canArrive ? "in_trip 상태에서만 도착 처리" : ""}
                          >
                            도착
                          </button>
                          <button
                            onClick={() => completeTrip(r.id)}
                            className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm disabled:opacity-50"
                            disabled={!canComplete}
                            title={!canComplete ? "in_trip/arrived에서 종료 가능" : ""}
                          >
                            종료
                          </button>
                        </>
                      )}
                    </div>

                    <button
                      onClick={() => goTrip(r.id)}
                      className="mt-2 w-full px-4 py-2 rounded-xl border bg-white text-sm"
                    >
                      실시간 지도 보기
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
