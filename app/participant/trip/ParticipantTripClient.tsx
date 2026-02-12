"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
import { subscribeRequest } from "../../lib/realtime";

type LatLngTuple = [number, number];
type LatLngObj = { lat: number; lng: number; ts?: string };

type ReqRow = {
  id: string;
  status: string | null;
  pickup_text: string | null;
  dropoff_text: string | null;

  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;

  participant_lat: number | null;
  participant_lng: number | null;

  participant_path?: LatLngObj[] | null;
  updated_at: string | null;

  // 코드에서 update에 participant_label 쓰고 있어서 타입에도 optional로 추가
  participant_label?: string | null;
};

const MapViewClient = dynamic(() => import("../../lib/MapViewClient"), { ssr: false });

// uuid 간단 체크
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ✅ 데모모드: 지금은 둘 다 항상 눌리게 (운영 전환 시 false로)
const DEMO_MODE = true;

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

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

export default function ParticipantTripPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get("id") ?? "";

  const [req, setReq] = useState<ReqRow | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [lastPulledAt, setLastPulledAt] = useState("");

  // 동선(폴리라인)
  const [path, setPath] = useState<LatLngTuple[]>([]);

  // GPS watch
  const watchIdRef = useRef<number | null>(null);
  const lastSavedRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastUploadAtRef = useRef<number>(0);

  const selectFields =
    "id,status,pickup_text,dropoff_text,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,participant_lat,participant_lng,participant_path,updated_at";

  const loadReq = async () => {
    if (!id) return;

    if (!UUID_RE.test(id)) {
      setErrorMsg(`id가 UUID 형식이 아닙니다: "${id}"`);
      setReq(null);
      return;
    }

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
    setReq(data as ReqRow);
    setLastPulledAt(new Date().toLocaleString());

    const raw = (data as any)?.participant_path as LatLngObj[] | null | undefined;
    if (Array.isArray(raw) && raw.length > 0) {
      const pts: LatLngTuple[] = raw
        .filter((p) => typeof p?.lat === "number" && typeof p?.lng === "number")
        .map((p) => [p.lat, p.lng]);
      setPath(pts.slice(-300));
    } else {
      setPath([]);
    }
  };

  // Realtime + 폴링
  useEffect(() => {
    if (!id) return;
    loadReq();
    const unsub = subscribeRequest(id, loadReq);
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const t = setInterval(() => loadReq(), 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const pickup: LatLngTuple | null = useMemo(() => {
    if (req?.pickup_lat == null || req?.pickup_lng == null) return null;
    return [req.pickup_lat, req.pickup_lng];
  }, [req?.pickup_lat, req?.pickup_lng]);

  const dropoff: LatLngTuple | null = useMemo(() => {
    if (req?.dropoff_lat == null || req?.dropoff_lng == null) return null;
    return [req.dropoff_lat, req.dropoff_lng];
  }, [req?.dropoff_lat, req?.dropoff_lng]);

  const participantPos: LatLngTuple | null = useMemo(() => {
    if (req?.participant_lat == null || req?.participant_lng == null) return null;
    return [req.participant_lat, req.participant_lng];
  }, [req?.participant_lat, req?.participant_lng]);

  // 단계 플래그
  const isAcceptedOrMet = req?.status === "accepted" || req?.status === "met";
  const isMovingToDropoff = req?.status === "in_trip" || req?.status === "arrived";
  const arrivedHighlight = req?.status === "arrived";

  // ✅ accepted/met 단계에서는 목적지 핀 숨김
  const mapDropoff = isMovingToDropoff ? dropoff : null;
  const mapShowLine = isMovingToDropoff; // in_trip/arrived에서만 선 표시

  // ETA 라벨/타겟
  const targetLabel = useMemo(() => {
    if (req?.status === "accepted" || req?.status === "met") return "출발지(요청자)까지 남은 거리/ETA";
    if (req?.status === "in_trip" || req?.status === "arrived") return "목적지까지 남은 거리/ETA";
    return "남은 거리/ETA";
  }, [req?.status]);

  const targetPoint = useMemo((): LatLngTuple | null => {
    if (!req) return null;
    if (req.status === "accepted" || req.status === "met") return pickup; // 출발지(요청자)
    if (req.status === "in_trip" || req.status === "arrived") return dropoff; // 목적지
    return null;
  }, [req, pickup, dropoff]);

  const distanceMeters = useMemo(() => {
    if (!participantPos || !targetPoint) return null;
    return haversineMeters(
      { lat: participantPos[0], lng: participantPos[1] },
      { lat: targetPoint[0], lng: targetPoint[1] }
    );
  }, [participantPos, targetPoint]);

  const etaMinutes = useMemo(() => {
    if (distanceMeters == null) return null;
    // 데모용: 80m/min
    return Math.max(1, Math.round(distanceMeters / 80));
  }, [distanceMeters]);

  // ✅ 만남 가능/동행 시작 가능
  const canMeet = useMemo(() => {
    if (!req) return false;
    if (req.status !== "accepted") return false;
    if (DEMO_MODE) return true; // 데모는 항상
    return distanceMeters != null && distanceMeters <= 30; // 운영은 30m
  }, [req, distanceMeters]);

  const canStartTrip = useMemo(() => {
    if (!req) return false;
    if (DEMO_MODE) return req.status === "accepted" || req.status === "met";
    return req.status === "met";
  }, [req]);

  // arrived 하이라이트 잠깐 표시
  const [flashArrived, setFlashArrived] = useState(false);
  useEffect(() => {
    if (arrivedHighlight) {
      setFlashArrived(true);
      const t = setTimeout(() => setFlashArrived(false), 4000);
      return () => clearTimeout(t);
    }
  }, [arrivedHighlight]);

  // completed면 목록으로
  useEffect(() => {
    if (req?.status === "completed") router.replace("/participant");
  }, [req?.status, router]);

  // =========================
  // GPS 업로드 + 동선 누적
  // =========================
  const stopGps = () => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    lastSavedRef.current = null;
    lastUploadAtRef.current = 0;
  };

  const uploadGPSAndAppendPath = async (requestId: string, lat: number, lng: number) => {
    const now = Date.now();
    if (now - lastUploadAtRef.current < 1000) return; // 1초 제한
    lastUploadAtRef.current = now;

    const { error: e1 } = await supabase
      .from("requests")
      .update({ participant_lat: lat, participant_lng: lng, participant_label: "참여자" })
      .eq("id", requestId);
    if (e1) throw e1;

    const cur = { lat, lng };
    const last = lastSavedRef.current;
    const moved = last ? haversineMeters(last, cur) : Infinity;
    if (moved < 5) return;

    const point = { lat, lng, ts: new Date().toISOString() };
    const { error: e2 } = await supabase.rpc("append_participant_point", {
      req_id: requestId,
      p: point,
    });
    if (e2) throw e2;

    lastSavedRef.current = cur;
  };

  const startGps = (requestId: string) => {
    if (!navigator.geolocation) {
      setErrorMsg("이 브라우저는 위치 기능을 지원하지 않습니다.");
      return;
    }
    stopGps();

    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        try {
          await uploadGPSAndAppendPath(requestId, pos.coords.latitude, pos.coords.longitude);
        } catch (e: any) {
          setErrorMsg("GPS 업로드 오류: " + (e?.message ?? String(e)));
        }
      },
      (err) => setErrorMsg("GPS 오류: " + err.message),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
    );
  };

  // accepted/met/in_trip/arrived면 자동 GPS 시작
  useEffect(() => {
    if (!req?.id) return;
    const s = req.status;
    if (s === "accepted" || s === "met" || s === "in_trip" || s === "arrived") startGps(req.id);
    return () => stopGps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.id, req?.status]);

  // =========================
  // 버튼 액션
  // =========================
  const meetRequester = async () => {
    if (!req?.id) return;

    const { error } = await supabase.from("requests").update({ status: "met" }).eq("id", req.id);
    if (error) {
      setErrorMsg("만남 처리 오류: " + error.message);
      return;
    }
    await loadReq();
  };

  const startTrip = async () => {
    if (!req?.id) return;

    const { error } = await supabase.from("requests").update({ status: "in_trip" }).eq("id", req.id);
    if (error) {
      setErrorMsg("동행 시작 오류: " + error.message);
      return;
    }
    await loadReq();
  };

  const arrive = async () => {
    if (!req?.id) return;

    const { error } = await supabase.from("requests").update({ status: "arrived" }).eq("id", req.id);
    if (error) {
      setErrorMsg("도착 처리 오류: " + error.message);
      return;
    }
    await loadReq();
  };

  const completeTrip = async () => {
    if (!req?.id) return;

    const { error } = await supabase.from("requests").update({ status: "completed" }).eq("id", req.id);
    if (error) {
      setErrorMsg("종료 처리 오류: " + error.message);
      return;
    }
    router.replace(`/participant/trip/complete?id=${req.id}`);
  };

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">실시간 이동 (참여자)</h1>
        <Link href="/participant" className="text-sm text-gray-600 underline">
          목록으로
        </Link>
      </div>

      {errorMsg && <div className="p-4 rounded-xl border bg-white text-red-600 mb-4">{errorMsg}</div>}

      <div className="grid gap-4 max-w-md">
        <div className="rounded-2xl border bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-500">지도 (동선 + 위치)</div>
            <div className="text-xs text-gray-500">갱신: {lastPulledAt || "-"}</div>
          </div>

          {!pickup ? (
            <p className="text-sm text-red-600">출발 좌표가 없습니다.</p>
          ) : (
            <>
              <MapViewClient
                pickup={pickup}
                dropoff={mapDropoff}
                participant={participantPos}
                participantPath={path}
                showLine={mapShowLine}
                followParticipant={true}
                showApproachingBadge={true}
                approaching={req?.status === "accepted" || req?.status === "met"} // 출발지로 이동중
                arrived={req?.status === "arrived"}
              />

              {/* ✅ accepted/met 단계: 만남 + 동행 시작 */}
              {isAcceptedOrMet && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    onClick={meetRequester}
                    disabled={!canMeet}
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm disabled:opacity-50"
                    title={!DEMO_MODE && !canMeet ? "요청자 30m 이내에서만 만남 가능" : ""}
                  >
                    요청자 만남
                  </button>

                  <button
                    onClick={startTrip}
                    disabled={!canStartTrip}
                    className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm disabled:opacity-50"
                    title={!DEMO_MODE && !canStartTrip ? "먼저 '요청자 만남'을 눌러주세요" : ""}
                  >
                    동행 시작
                  </button>
                </div>
              )}

              {/* ✅ in_trip/arrived 단계: 도착 + 종료 */}
              {isMovingToDropoff && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    onClick={arrive}
                    disabled={req?.status !== "in_trip"}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm disabled:opacity-50"
                    title={req?.status !== "in_trip" ? "in_trip 상태에서만 도착 가능" : ""}
                  >
                    도착
                  </button>

                  <button onClick={completeTrip} className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm">
                    종료
                  </button>
                </div>
              )}

              {/* ✅ 남은 거리/ETA */}
              <div className="mt-4 text-xs text-gray-700 rounded-xl border bg-white px-3 py-2">
                <div className="font-semibold mb-1">{targetLabel}</div>
                <div>
                  남은 거리: <b>{distanceMeters == null ? "-" : formatDistance(distanceMeters)}</b> · ETA:{" "}
                  <b>{etaMinutes == null ? "-" : `${etaMinutes}분`}</b>
                </div>
                <div className="text-[11px] text-gray-500 mt-1">
                  * 데모용 추정치(직선거리 기반) — 실제 경로/교통 반영 전
                </div>
              </div>

              {/* ✅ 안내 */}
              {(req?.status === "accepted" || req?.status === "met") && (
                <div className="mt-2 inline-flex items-center gap-2 text-xs font-semibold text-emerald-700">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600" />
                  </span>
                  {req?.status === "accepted" ? "요청자(출발지)로 이동 중" : "만남 완료 — 동행 시작 가능"}
                </div>
              )}

              {/* ✅ 목적지 도착 강조 */}
              {(arrivedHighlight || flashArrived) && (
                <div className="mt-3 p-3 rounded-xl border bg-amber-50 text-amber-800 text-sm font-semibold">
                  ✅ 목적지 도착! (arrived)
                </div>
              )}

              {!participantPos && (
                <p className="mt-2 text-xs text-gray-500">참여자 위치가 아직 없습니다. 브라우저 위치 권한을 허용하세요.</p>
              )}
            </>
          )}
        </div>

        {/* 요약 카드 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm text-gray-500">요약</div>
          <div className="mt-2 text-sm">출발: {req?.pickup_text ?? "-"}</div>
          <div className="text-sm">도착: {req?.dropoff_text ?? "-"}</div>
          <div className="text-sm mt-2">
            상태: <b>{req?.status ?? "-"}</b>
          </div>
        </div>
      </div>
    </main>
  );
}
