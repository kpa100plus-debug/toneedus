"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

import { supabase } from "../../lib/supabaseClient";
import { fetchEvents, type EventRow } from "../../lib/eventLogger";
import { subscribeEvents, subscribeRequest } from "../../lib/realtime";
import RequestEventsLog from "../../lib/RequestEventsLog";


type LatLng = [number, number];

type ReqRow = {
  id: string;
  status: string | null;

  pickup_text: string | null;
  dropoff_text: string | null;

  participant_label: string | null;

  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;

  participant_lat: number | null;
  participant_lng: number | null;

  participant_path?: any[] | null;

  updated_at: string | null;
};

const MapViewClient = dynamic(() => import("../../lib/MapViewClient"), {
  ssr: false,
});

function toPath(arr: any[] | null | undefined): LatLng[] {
  if (!arr || !Array.isArray(arr)) return [];
  const out: LatLng[] = [];
  for (const p of arr) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    out.push([lat, lng]);
  }
  return out.length > 400 ? out.slice(out.length - 400) : out;
}

// ✅ 거리 계산 (Haversine meters)
function haversineMeters(a: LatLng, b: LatLng) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m: number | null) {
  if (m == null || !isFinite(m)) return "-";
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ✅ ETA 추정(데모용) — 거리에 따라 속도 가정
function estimateEtaMinutes(distanceMeters: number | null) {
  if (distanceMeters == null || !isFinite(distanceMeters) || distanceMeters <= 0) return null;
  // 가까우면 도보, 중간은 자전거/스쿠터, 멀면 차량
  const speedKmh =
    distanceMeters < 1200 ? 5 :
    distanceMeters < 5000 ? 18 :
    30;

  const metersPerMin = (speedKmh * 1000) / 60;
  return Math.max(1, Math.ceil(distanceMeters / metersPerMin));
}

export default function RequesterTripPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get("id");

  const [req, setReq] = useState<ReqRow | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [lastPulledAt, setLastPulledAt] = useState<string>("");

  const [path, setPath] = useState<LatLng[]>([]);

  const selectFields =
    "id,status,pickup_text,dropoff_text,participant_label,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,participant_lat,participant_lng,participant_path,updated_at";

  const loadReq = async () => {
    if (!id) return;

    const { data, error } = await supabase
      .from("requests")
      .select(selectFields)
      .eq("id", id)
      .single();

    if (error) {
      setErrorMsg(error.message);
      return;
    }

    setErrorMsg("");
    const row = data as ReqRow;
    setReq(row);
    setLastPulledAt(new Date().toLocaleString());
    setPath(toPath(row.participant_path));
  };

  const loadEvents = async () => {
    if (!id) return;
    try {
      const list = await fetchEvents(id);
      setEvents(list);
    } catch (e: any) {
      setErrorMsg(e?.message ?? "이벤트 로드 오류");
    }
  };

  useEffect(() => {
    if (!id) return;

    loadReq();
    loadEvents();

    const unsubReq = subscribeRequest(id, loadReq);
    const unsubEv = subscribeEvents(id, loadEvents);

    return () => {
      unsubReq();
      unsubEv();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const t = setInterval(() => {
      loadReq();
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const pickup: LatLng | null = useMemo(() => {
    if (req?.pickup_lat == null || req?.pickup_lng == null) return null;
    return [req.pickup_lat, req.pickup_lng];
  }, [req?.pickup_lat, req?.pickup_lng]);

  const dropoff: LatLng | null = useMemo(() => {
    if (req?.dropoff_lat == null || req?.dropoff_lng == null) return null;
    return [req.dropoff_lat, req.dropoff_lng];
  }, [req?.dropoff_lat, req?.dropoff_lng]);

  const participantPos: LatLng | null = useMemo(() => {
    if (req?.participant_lat == null || req?.participant_lng == null) return null;
    return [req.participant_lat, req.participant_lng];
  }, [req?.participant_lat, req?.participant_lng]);

  const statusLabel = useMemo(() => {
    const s = req?.status ?? "-";
    if (s === "broadcasted") return "매칭 중";
    if (s === "accepted") return "수락됨";
    if (s === "in_trip") return "이동 중";
    if (s === "arrived") return "도착";
    if (s === "completed") return "완료";
    if (s === "cancelled") return "취소";
    return s;
  }, [req?.status]);

  // ✅ 남은 거리/ETA (참여자 → 도착지)
  const remainingMeters = useMemo(() => {
    if (!participantPos || !dropoff) return null;
    return haversineMeters(participantPos, dropoff);
  }, [participantPos, dropoff]);

  const etaMinutes = useMemo(() => estimateEtaMinutes(remainingMeters), [remainingMeters]);

  useEffect(() => {
    if (!id) return;
    if (req?.status === "completed") {
      router.replace(`/requester/trip/complete?id=${id}`);
    }
  }, [req?.status, id, router]);

  if (!id) {
    return (
      <main className="min-h-screen p-6 bg-gray-50">
        <h1 className="text-2xl font-bold">실시간 이동 (요청자)</h1>
        <p className="mt-4 text-red-600">
          id가 없습니다. /requester/trip?id=... 로 들어와야 합니다.
        </p>
        <Link className="underline text-blue-600" href="/requester">
          요청 화면으로
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">실시간 이동 (요청자)</h1>
        <Link href="/" className="text-sm text-gray-600 underline">
          홈으로
        </Link>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl border bg-white text-red-600 mb-4">
          {errorMsg}
        </div>
      )}

      <div className="grid gap-4 max-w-md">
        {/* ✅ 지도 카드 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-500">실시간 지도</div>
            <div className="text-xs text-gray-500">갱신: {lastPulledAt || "-"}</div>
          </div>

          {!pickup ? (
            <p className="text-sm text-red-600">
              pickup_lat/lng 값이 없습니다. (요청 생성 시 현재 위치 저장이 필요해요)
            </p>
          ) : (
            <>
              <MapViewClient
                pickup={pickup}
                dropoff={dropoff}
                participant={participantPos}
                participantPath={path}
                showLine={true}
                followParticipant={true}
                showApproachingBadge={true}
              />

              <div className="mt-2 text-xs text-gray-600">
                상태: <b>{statusLabel}</b>
                {req?.status === "arrived" && <span className="ml-2">✅ 목적지 도착</span>}
                {path.length > 1 && <span className="ml-2">· 동선 {path.length}점</span>}
              </div>
            </>
          )}

          {!participantPos && (
            <p className="mt-2 text-xs text-gray-500">
              참여자 위치가 아직 없습니다. 참여자 화면에서 위치 권한을 허용하세요.
            </p>
          )}
        </div>

        {/* ✅ 남은 거리/ETA 카드 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm text-gray-500">목적지까지 남은 거리/ETA</div>
          <div className="mt-2 text-sm">
            남은 거리: <b>{formatDistance(remainingMeters)}</b>
          </div>
          <div className="mt-1 text-sm">
            ETA: <b>{etaMinutes == null ? "-" : `${etaMinutes}분`}</b>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            * 데모용 추정치(직선거리 기반) — 실제 경로/교통 반영 전
          </div>
        </div>

        {/* ✅ 상태 카드 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm text-gray-500">요청 ID</div>
          <div className="font-mono break-all">{id}</div>

          <div className="mt-4 text-sm text-gray-600">현재 상태</div>
          <div className="text-lg font-semibold">{statusLabel}</div>

          <div className="mt-4 text-sm text-gray-600">출발</div>
          <div className="text-sm">{req?.pickup_text ?? "-"}</div>

          <div className="mt-2 text-sm text-gray-600">도착</div>
          <div className="text-sm">{req?.dropoff_text ?? "-"}</div>

          <div className="mt-4 text-sm text-gray-600">참여자</div>
          <div className="font-semibold">{req?.participant_label ?? "-"}</div>

          <div className="mt-4 text-sm text-gray-600">참여자 위치(DB)</div>
          <div className="font-mono text-sm">
            lat: {req?.participant_lat ?? "-"} / lng: {req?.participant_lng ?? "-"}
          </div>
        </div>

        {/* ✅ 이벤트 로그 */}
        <RequestEventsLog requestId={id} />
      </div>
    </main>
  );
}
