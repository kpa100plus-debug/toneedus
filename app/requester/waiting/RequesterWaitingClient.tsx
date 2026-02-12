"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import MapView from "../../lib/MapView";
import { supabase } from "../../lib/supabaseClient";
import RequestEventsLog from "../../lib/RequestEventsLog";

type LatLng = [number, number];

export default function RequesterWaitingClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get("id") || "";

  const [req, setReq] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  // ✅ 중복 이동 방지
  const movedRef = useRef(false);

  // ✅ 폴링 비교용 (stale req 방지)
  const lastStatusRef = useRef<string | null>(null);

  const pickup = useMemo<LatLng>(() => {
    const lat = Number(req?.pickup_lat);
    const lng = Number(req?.pickup_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [37.5172, 127.0473];
    return [lat, lng];
  }, [req]);

  const dropoff = useMemo<LatLng>(() => {
    const lat = Number(req?.dropoff_lat);
    const lng = Number(req?.dropoff_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return pickup;
    return [lat, lng];
  }, [req, pickup]);

  const goAcceptedIfNeeded = (next: any) => {
    if (!next) return;
    if (next.status === "accepted" && !movedRef.current) {
      movedRef.current = true;
      router.replace(`/requester/accepted?id=${id}`);
    }
  };

  // ✅ 1) 최초 1회 조회
  useEffect(() => {
    if (!id) return;

    let alive = true;

    (async () => {
      try {
        setLoading(true);
        setErrorMsg("");

        const { data, error } = await supabase
          .from("requests")
          .select("*")
          .eq("id", id)
          .single();

        if (!alive) return;

        if (error) {
          console.error("❌ waiting fetch error:", error);
          setReq(null);
          setErrorMsg(error.message);
          setLoading(false);
          return;
        }

        setReq(data);
        lastStatusRef.current = data?.status ?? null;
        setLoading(false);
        goAcceptedIfNeeded(data);
      } catch (e: any) {
        if (!alive) return;
        setErrorMsg(e?.message ?? String(e));
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [id, router]);

  // ✅ 2) Realtime + 폴링(백업)
  useEffect(() => {
    if (!id) return;

    // --- Realtime ---
    const channel = supabase
      .channel(`requester-waiting-${id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "requests",
          filter: `id=eq.${id}`,
        },
        (payload: any) => {
          const next = payload?.new;
          if (!next) return;

          console.log("📡 realtime update:", next.status);
          setReq(next);
          lastStatusRef.current = next?.status ?? null;
          goAcceptedIfNeeded(next);
        }
      )
      .subscribe((status) => {
        console.log("📡 realtime subscribe status:", status);
      });

    // --- Polling ---
    const timer = setInterval(async () => {
      if (movedRef.current) return;

      const { data, error } = await supabase
        .from("requests")
        .select("*")
        .eq("id", id)
        .single();

      if (error || !data) return;

      const prev = lastStatusRef.current;
      const nextStatus = data?.status ?? null;

      if (prev !== nextStatus) {
        console.log("🕵️ polling status:", nextStatus);
        setReq(data);
        lastStatusRef.current = nextStatus;
        goAcceptedIfNeeded(data);
      }
    }, 1500);

    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, [id, router]);

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">매칭 대기</h1>
        <Link href="/requester" className="text-sm text-gray-600 underline">
          뒤로
        </Link>
      </div>

      <div className="max-w-md space-y-4">
        {errorMsg && (
          <div className="rounded-2xl border bg-white p-4 text-sm text-red-600">
            {errorMsg}
          </div>
        )}

        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm text-gray-600">요청 ID</div>
          <div className="font-mono break-all text-sm">{id || "-"}</div>

          <div className="mt-3 text-sm text-gray-700 space-y-1">
            <div>
              상태: <b>{loading ? "loading..." : req?.status ?? "-"}</b>
            </div>
            <div>출발: {req?.pickup_text ?? "-"}</div>
            <div>도착: {req?.dropoff_text ?? "-"}</div>
          </div>

          <div className="mt-2 text-xs text-gray-500">
            참여자가 수락하면 자동으로 수락 완료 화면으로 넘어갑니다.
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm font-semibold mb-2">이동 경로 미리보기</div>
          <MapView
            pickup={pickup}
            dropoff={dropoff}
            participant={null}
            showLine={true}
            followParticipant={false}
            followPickup={false}
          />
        </div>

        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm font-semibold mb-2">이벤트 로그</div>
          <RequestEventsLog requestId={id} />
        </div>
      </div>
    </main>
  );
}
