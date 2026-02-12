"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "../lib/supabaseClient";
import { logEvent } from "../lib/logEvent";

type ReqRow = {
  id: string;
  status: string | null;
  pickup_text: string | null;
  dropoff_text: string | null;
  participant_lat: number | null;
  participant_lng: number | null;
  participant_loc_updated_at: string | null;
};

export default function TripClient() {
  const sp = useSearchParams();
  const id = sp.get("id") || "";

  const [req, setReq] = useState<ReqRow | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [gpsOn, setGpsOn] = useState(false);

  const watchIdRef = useRef<number | null>(null);

  // 1) 요청 정보 로드
  const fetchReq = async () => {
    if (!id) return;
    setErrorMsg("");

    const { data, error } = await supabase
      .from("requests")
      .select(
        "id,status,pickup_text,dropoff_text,participant_lat,participant_lng,participant_loc_updated_at"
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      setErrorMsg(error.message);
      return;
    }

    setReq((data as ReqRow) ?? null);
  };

  useEffect(() => {
    fetchReq();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 2) 상태 업데이트 + 이벤트 로그 (in_trip, completed)
  const updateStatus = async (nextStatus: string, message: string) => {
    if (!id) return;
    setErrorMsg("");

    const { error } = await supabase
      .from("requests")
      .update({ status: nextStatus })
      .eq("id", id);

    if (error) {
      setErrorMsg(error.message);
      return;
    }

    // ✅ events 기록
    await logEvent({
      requestId: id,
      type: nextStatus,
      message,
      actor: "participant",
    });

    // 화면 즉시 반영
    setReq((r) => (r ? { ...r, status: nextStatus } : r));
  };

  // 3) 도착: status는 건드리지 않고 events만 기록 (DB 제약 안전)
  const markArrived = async () => {
    if (!id) return;
    setErrorMsg("");

    try {
      await logEvent({
        requestId: id,
        type: "arrived",
        message: "도착",
        actor: "participant",
      });
    } catch (e: any) {
      setErrorMsg(e?.message ?? "도착 로그 기록 오류");
    }
  };

  // 4) GPS 업데이트(선택 기능)
  const upsertLocation = async (lat: number, lng: number) => {
    if (!id) return;

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("requests")
      .update({
        participant_lat: lat,
        participant_lng: lng,
        participant_loc_updated_at: now,
      })
      .eq("id", id);

    if (error) {
      console.error("location update error:", error.message);
      setErrorMsg(error.message);
      return;
    }

    setReq((r) =>
      r
        ? {
            ...r,
            participant_lat: lat,
            participant_lng: lng,
            participant_loc_updated_at: now,
          }
        : r
    );
  };

  const startGps = () => {
    if (!navigator.geolocation) {
      setErrorMsg("이 브라우저에서 GPS를 지원하지 않습니다.");
      return;
    }

    setErrorMsg("");
    if (watchIdRef.current !== null) return;

    const wid = navigator.geolocation.watchPosition(
      async (pos) => {
        await upsertLocation(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        setErrorMsg(`GPS 오류: ${err.message}`);
        stopGps();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    watchIdRef.current = wid;
    setGpsOn(true);
  };

  const stopGps = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setGpsOn(false);
  };

  useEffect(() => {
    return () => stopGps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusText = req?.status ?? "-";

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-4">
        <div className="text-2xl font-bold">Trip (참여자)</div>
        <Link className="text-sm text-gray-500 hover:underline" href="/participant">
          참여자 목록으로
        </Link>
      </div>

      {!id && (
        <div className="rounded-2xl border bg-white p-4">
          <div className="font-semibold">요청 ID가 없습니다.</div>
          <div className="text-sm text-gray-500 mt-1">URL에 ?id=... 형태가 필요합니다.</div>
        </div>
      )}

      {errorMsg && (
        <div className="mb-4 rounded-2xl border bg-white p-4 text-sm text-red-600">{errorMsg}</div>
      )}

      <div className="rounded-2xl border bg-white p-4">
        <div className="text-sm text-gray-500">요청 ID</div>
        <div className="font-mono break-all">{id}</div>

        <div className="mt-4 text-sm text-gray-500">현재 상태</div>
        <div className="text-lg font-semibold">{statusText}</div>

        <div className="mt-4 text-sm text-gray-500">출발/도착</div>
        <div>출발: {req?.pickup_text ?? "-"}</div>
        <div>도착: {req?.dropoff_text ?? "-"}</div>
      </div>

      <div className="mt-6 rounded-2xl border bg-white p-4">
        <div className="font-semibold mb-3">진행 버튼(데모)</div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => updateStatus("in_trip", "이동 시작")}
            className="px-4 py-2 rounded-xl bg-blue-600 text-white"
            disabled={!id}
          >
            이동 시작
          </button>

          <button
            type="button"
            onClick={markArrived}
            className="px-4 py-2 rounded-xl bg-green-600 text-white"
            disabled={!id}
          >
            도착
          </button>

          <button
            type="button"
            onClick={() => updateStatus("completed", "종료")}
            className="px-4 py-2 rounded-xl bg-black text-white"
            disabled={!id}
          >
            종료
          </button>

          {!gpsOn ? (
            <button
              type="button"
              onClick={startGps}
              className="px-4 py-2 rounded-xl bg-gray-200"
              disabled={!id}
            >
              GPS 시작
            </button>
          ) : (
            <button type="button" onClick={stopGps} className="px-4 py-2 rounded-xl bg-gray-200">
              GPS 중지
            </button>
          )}

          <button
            type="button"
            onClick={fetchReq}
            className="px-4 py-2 rounded-xl bg-gray-200"
            disabled={!id}
          >
            새로고침
          </button>
        </div>

        <div className="mt-4 text-sm text-gray-500">내 위치(최근 DB 값)</div>
        <div className="text-sm">
          lat: {req?.participant_lat ?? "-"} / lng: {req?.participant_lng ?? "-"}
        </div>
        <div className="text-xs text-gray-400">
          updated_at: {req?.participant_loc_updated_at ?? "-"}
        </div>
        <div className="text-xs text-gray-400 mt-2">
          * 폰(모바일) 브라우저에서 GPS 권한을 “허용”해야 합니다.
        </div>
      </div>
    </main>
  );
}
