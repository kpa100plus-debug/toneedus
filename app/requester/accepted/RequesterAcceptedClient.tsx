"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
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
  participant_lat: number | null;
  participant_lng: number | null;
};

// ✅ leaflet/Map 계열은 서버에서 평가되면 window 에러 -> ssr:false로 강제
const MapViewClient = dynamic(() => import("../../lib/MapViewClient"), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] rounded-xl border bg-gray-50 flex items-center justify-center text-sm text-gray-500">
      지도 로딩중...
    </div>
  ),
});

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

function formatDistance(m: number) {
  if (!isFinite(m)) return "-";
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

function estimateEtaMinutes(distanceMeters: number) {
  if (!isFinite(distanceMeters) || distanceMeters <= 0) return null;
  const speedKmh = distanceMeters < 1200 ? 5 : distanceMeters < 5000 ? 18 : 30;
  const metersPerMinute = (speedKmh * 1000) / 60;
  return Math.max(1, Math.ceil(distanceMeters / metersPerMinute));
}

export default function RequesterAcceptedClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get("id");

  const [req, setReq] = useState<ReqRow | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [lastPulledAt, setLastPulledAt] = useState("");

  const [participantPath, setParticipantPath] = useState<LatLng[]>([]);
  const lastKeyRef = useRef<string>("");

  const load = async () => {
    if (!id) return;

    const { data, error } = await supabase
      .from("requests")
      .select(
        "id,status,pickup_text,dropoff_text,participant_label,pickup_lat,pickup_lng,participant_lat,participant_lng"
      )
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

    if (row.participant_lat != null && row.participant_lng != null) {
      const key = `${row.participant_lat.toFixed(6)},${row.participant_lng.toFixed(6)}`;
      if (lastKeyRef.current !== key) {
        lastKeyRef.current = key;
        setParticipantPath((prev) => [...prev, [row.participant_lat!, row.participant_lng!]]);
      }
    }
  };

  useEffect(() => {
    if (!id) return;

    load();
    const t = setInterval(load, 1200);

    const ch = supabase
      .channel(`req-accepted-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "requests", filter: `id=eq.${id}` },
        () => load()
      )
      .subscribe();

    return () => {
      clearInterval(t);
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const pickup: LatLng | null = useMemo(() => {
    if (req?.pickup_lat == null || req?.pickup_lng == null) return null;
    return [req.pickup_lat, req.pickup_lng];
  }, [req?.pickup_lat, req?.pickup_lng]);

  const participant: LatLng | null = useMemo(() => {
    if (req?.participant_lat == null || req?.participant_lng == null) return null;
    return [req.participant_lat, req.participant_lng];
  }, [req?.participant_lat, req?.participant_lng]);

  const distanceMeters = useMemo(() => {
    if (!pickup || !participant) return null;
    return haversineMeters(pickup, participant);
  }, [pickup, participant]);

  const etaMinutes = useMemo(() => {
    if (!distanceMeters) return null;
    return estimateEtaMinutes(distanceMeters);
  }, [distanceMeters]);

  useEffect(() => {
    if (!id) return;
    if (req?.status === "in_trip") router.replace(`/requester/trip?id=${id}`);
  }, [req?.status, id, router]);

  if (!id) {
    return (
      <main className="min-h-screen p-6 bg-gray-50">
        <h1 className="text-2xl font-bold">참여자 오는 중</h1>
        <p className="mt-4 text-red-600">
          id가 없습니다. /requester/accepted?id=... 로 들어와야 합니다.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">참여자 오는 중</h1>
        <Link href="/requester" className="text-sm text-gray-700 underline">
          요청 화면으로
        </Link>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl border bg-white text-red-600 mb-4">{errorMsg}</div>
      )}

      <div className="max-w-md space-y-4">
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-lg font-semibold">참여자 님이 오고 있어요 ✅</div>

          <div className="mt-2 text-sm text-gray-700">
            참여자: <b>{req?.participant_label ?? "-"}</b>
          </div>

          <div className="mt-3 text-sm text-gray-700 space-y-1">
            <div>출발(요청자 위치): {req?.pickup_text ?? "-"}</div>
            <div>도착: {req?.dropoff_text ?? "-"}</div>
          </div>

          <div className="mt-3 rounded-xl border bg-gray-50 p-3 text-sm">
            <div className="font-semibold">접근 정보</div>
            <div className="mt-1 text-gray-700">
              거리: <b>{distanceMeters == null ? "-" : formatDistance(distanceMeters)}</b> · ETA:{" "}
              <b>{etaMinutes == null ? "-" : `${etaMinutes}분`}</b>
            </div>
            <div className="mt-1 text-xs text-gray-500">* ETA는 데모용 추정치(거리 기반)입니다.</div>
          </div>

          <div className="mt-3 text-xs text-gray-500">상태: {req?.status ?? "-"}</div>
          <div className="mt-1 text-xs text-gray-500">갱신: {lastPulledAt || "-"}</div>
          <div className="mt-2 text-xs text-gray-400 break-all">id: {id}</div>
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">참여자 이동 지도</div>
            <div className="text-xs text-gray-500">* 참여자 위치가 갱신되면 자동 반영</div>
          </div>

          {!pickup ? (
            <div className="text-sm text-red-600">pickup_lat/lng 값이 없습니다.</div>
          ) : (
            <>
              <MapViewClient
                pickup={pickup}
                dropoff={null}
                participant={participant}
                participantPath={participantPath}
                followParticipant={true}
                showLine={false}
                showApproachingBadge={true}
              />

              <div className="mt-2 text-xs text-gray-700">
                요약: 거리 <b>{distanceMeters == null ? "-" : formatDistance(distanceMeters)}</b> · ETA{" "}
                <b>{etaMinutes == null ? "-" : `${etaMinutes}분`}</b>
              </div>
            </>
          )}
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm font-semibold mb-2">이벤트 로그</div>
          {id && <RequestEventsLog requestId={id} />}
        </div>
      </div>
    </main>
  );
}
