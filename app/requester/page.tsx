"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";
import { reverseGeocodeOSM } from "../lib/reverseGeocode";

type LatLng = [number, number];

type KakaoDoc = {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  x: string; // lng
  y: string; // lat
};

const MapViewClient = dynamic(() => import("../lib/MapViewClient"), { ssr: false });

export default function RequesterPage() {
  const router = useRouter();

  // 출발
  const [pickupText, setPickupText] = useState<string>("현재 위치");
  const [pickup, setPickup] = useState<LatLng | null>(null);

  // 도착
  const [dropoffText, setDropoffText] = useState<string>("");
  const [dropoff, setDropoff] = useState<LatLng | null>(null);

  // 지도 클릭 모드
  const [clickMode, setClickMode] = useState<"pickup" | "dropoff" | null>(null);

  // 검색
  const [pickupQuery, setPickupQuery] = useState<string>("");
  const [dropoffQuery, setDropoffQuery] = useState<string>("");
  const [pickupResults, setPickupResults] = useState<KakaoDoc[]>([]);
  const [dropoffResults, setDropoffResults] = useState<KakaoDoc[]>([]);
  const [showPickupResults, setShowPickupResults] = useState(false);
  const [showDropoffResults, setShowDropoffResults] = useState(false);

  const [msg, setMsg] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [geoLoading, setGeoLoading] = useState<boolean>(false);

  const fallback: LatLng = [37.5665, 126.978];
  const mapPickup = pickup ?? fallback;

  // 바깥 클릭하면 드롭다운 닫기 (검색창 영역 제외)
  useEffect(() => {
    const handler = () => {
      setShowPickupResults(false);
      setShowDropoffResults(false);
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  const getCurrentLocationAsPickup = () => {
    if (!navigator.geolocation) {
      setMsg("이 브라우저는 위치 기능을 지원하지 않습니다.");
      return;
    }

    setMsg("현재 위치를 가져오는 중...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        setPickup([lat, lng]);
        setPickupText("현재 위치");
        setMsg("출발(현재 위치) 설정 ✅");
      },
      (err) => setMsg("위치 오류: " + err.message),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 2000 }
    );
  };

  useEffect(() => {
    getCurrentLocationAsPickup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchKakao = async (q: string) => {
    const res = await fetch(`/api/kakao/keyword?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const data = await res.json();
    return (data?.documents ?? []) as KakaoDoc[];
  };

  const doSearchPickup = async () => {
    const q = pickupQuery.trim();
    if (q.length < 2) return setMsg("출발지 검색어를 2글자 이상 입력하세요.");

    setMsg("출발지 검색 중...");
    try {
      const docs = await searchKakao(q);
      setPickupResults(docs);
      setShowPickupResults(true);
      setShowDropoffResults(false);
      setMsg(docs.length ? "출발지 검색 결과 ✅ 선택하세요." : "검색 결과가 없습니다.");
    } catch (e: any) {
      setMsg("출발지 검색 오류: " + (e?.message ?? ""));
    }
  };

  const doSearchDropoff = async () => {
    const q = dropoffQuery.trim();
    if (q.length < 2) return setMsg("도착지 검색어를 2글자 이상 입력하세요.");

    setMsg("도착지 검색 중...");
    try {
      const docs = await searchKakao(q);
      setDropoffResults(docs);
      setShowDropoffResults(true);
      setShowPickupResults(false);
      setMsg(docs.length ? "도착지 검색 결과 ✅ 선택하세요." : "검색 결과가 없습니다.");
    } catch (e: any) {
      setMsg("도착지 검색 오류: " + (e?.message ?? ""));
    }
  };

  const applyPickupFromResult = (d: KakaoDoc) => {
    const lat = Number(d.y);
    const lng = Number(d.x);
    setPickup([lat, lng]);

    const label = d.place_name || d.road_address_name || d.address_name || "선택한 출발지";
    setPickupText(label);

    // ✅ 닫기
    setShowPickupResults(false);
    setPickupResults([]);
    setMsg(`출발지 선택 ✅ ${label}`);
  };

  const applyDropoffFromResult = (d: KakaoDoc) => {
    const lat = Number(d.y);
    const lng = Number(d.x);
    setDropoff([lat, lng]);

    const label = d.place_name || d.road_address_name || d.address_name || "선택한 도착지";
    setDropoffText(label);

    // ✅ 닫기
    setShowDropoffResults(false);
    setDropoffResults([]);
    setMsg(`도착지 선택 ✅ ${label}`);
  };

  const onPickPickupByMap = async (pos: LatLng) => {
    setPickup(pos);
    setGeoLoading(true);
    setMsg("출발지 좌표 선택 ✅ 주소 변환 중...");
    try {
      const addr = await reverseGeocodeOSM(pos[0], pos[1]);
      setPickupText(addr || "지도에서 선택한 출발지");
      setMsg("출발지 선택(지도) ✅");
    } catch {
      setPickupText("지도에서 선택한 출발지");
      setMsg("출발지 주소 변환 실패(지도 선택은 적용됨)");
    } finally {
      setGeoLoading(false);
    }
  };

  const onPickDropoffByMap = async (pos: LatLng) => {
    setDropoff(pos);
    setGeoLoading(true);
    setMsg("도착지 좌표 선택 ✅ 주소 변환 중...");
    try {
      const addr = await reverseGeocodeOSM(pos[0], pos[1]);
      setDropoffText(addr || "지도에서 선택한 도착지");
      setMsg("도착지 선택(지도) ✅");
    } catch {
      setDropoffText("지도에서 선택한 도착지");
      setMsg("도착지 주소 변환 실패(지도 선택은 적용됨)");
    } finally {
      setGeoLoading(false);
    }
  };

  const createRequest = async () => {
    if (!pickup) return setMsg("출발 좌표가 없습니다. 출발을 지정하세요.");
    if (!dropoff) return setMsg("도착 좌표가 없습니다. 도착을 지정하세요.");

    setLoading(true);
    setMsg("요청 생성 중...");

    const { data, error } = await supabase
      .from("requests")
      .insert({
        status: "broadcasted",
        pickup_text: pickupText || "출발지",
        dropoff_text: dropoffText || "도착지",
        requester_label: "요청자",
        pickup_lat: pickup[0],
        pickup_lng: pickup[1],
        dropoff_lat: dropoff[0],
        dropoff_lng: dropoff[1],
      })
      .select("id")
      .single();

    setLoading(false);
    if (error) return setMsg("요청 생성 오류: " + error.message);

    router.push(`/requester/waiting?id=${data.id}`);
  };

  // ✅ 드롭다운(겹침) UI 컴포넌트
// ✅ 드롭다운(겹침) UI 컴포넌트 + 닫기 ✕
const ResultDropdown = ({
  visible,
  items,
  onPick,
  onClose,
  title = "검색 결과",
}: {
  visible: boolean;
  items: KakaoDoc[];
  onPick: (d: KakaoDoc) => void;
  onClose: () => void;
  title?: string;
}) => {
  if (!visible || items.length === 0) return null;

  return (
    <div
      className="absolute left-0 right-0 mt-2 bg-white border rounded-xl shadow-lg overflow-hidden"
      style={{ zIndex: 9999 }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* ✅ 상단 헤더 + 닫기 */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-white">
        <div className="text-xs font-semibold text-gray-700">{title}</div>

        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 rounded-lg hover:bg-gray-100"
          aria-label="닫기"
        >
          닫기 ✕
        </button>
      </div>

      <div className="max-h-[260px] overflow-auto">
        {items.map((d) => (
          <button
            key={d.id}
            onClick={() => onPick(d)}
            className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b last:border-b-0"
          >
            <div className="font-semibold text-sm">{d.place_name}</div>
            <div className="text-xs text-gray-500">
              {d.road_address_name || d.address_name || "-"}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};



  return (
    <main className="min-h-screen p-6 bg-gray-50" onClick={() => {}}>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">요청 생성 (요청자)</h1>
        <Link href="/" className="text-sm text-gray-600 underline">
          홈으로
        </Link>
      </div>

      {msg && <div className="p-3 rounded-xl border bg-white text-sm mb-4">{msg}</div>}

      <div className="grid gap-4 max-w-md">
        {/* 출발 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm font-semibold mb-3">출발</div>

          <div className="flex gap-2 mb-3">
            <button
              onClick={() => {
                setClickMode(null);
                getCurrentLocationAsPickup();
              }}
              className="px-4 py-2 rounded-xl border bg-white text-sm"
              disabled={loading || geoLoading}
            >
              출발: 현재 위치
            </button>

            <button
              onClick={() => {
                setClickMode((m) => (m === "pickup" ? null : "pickup"));
                setShowPickupResults(false);
                setShowDropoffResults(false);
              }}
              className="px-4 py-2 rounded-xl border bg-white text-sm"
              disabled={loading || geoLoading}
            >
              출발 지도선택 {clickMode === "pickup" ? "ON" : "OFF"}
            </button>
          </div>

          <div className="text-xs text-gray-500 mb-1">출발지 검색(전국)</div>

          {/* ✅ relative 컨테이너 안에서 dropdown을 absolute로 띄움 */}
          <div
  className="relative"
  onClick={(e) => e.stopPropagation()} // 바깥 클릭으로 닫히는 것 방지
>
  <div className="flex gap-2">
    <input
      value={pickupQuery}
      onChange={(e) => setPickupQuery(e.target.value)}
      className="flex-1 border rounded-xl px-3 py-2 text-sm"
      placeholder="예) 서울역 / 부산역 / 인천공항"
      onFocus={() => {
        if (pickupResults.length) setShowPickupResults(true);
        setShowDropoffResults(false);
      }}
    />
    <button
      onClick={doSearchPickup}
      className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm"
    >
      검색
    </button>
  </div>

  <ResultDropdown
  visible={showPickupResults}
  items={pickupResults}
  onPick={applyPickupFromResult}
  onClose={() => setShowPickupResults(false)}
  title="출발지 검색 결과"
/>

</div>


          <div className="mt-3 text-xs text-gray-700">
            출발: <b>{pickupText || "-"}</b>
          </div>
        </div>

        {/* 도착 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-sm font-semibold mb-3">도착</div>

          <div className="flex gap-2 mb-3">
            <button
              onClick={() => {
                setClickMode((m) => (m === "dropoff" ? null : "dropoff"));
                setShowPickupResults(false);
                setShowDropoffResults(false);
              }}
              className="px-4 py-2 rounded-xl border bg-white text-sm"
              disabled={loading || geoLoading}
            >
              도착 지도선택 {clickMode === "dropoff" ? "ON" : "OFF"}
            </button>

            <div className="text-xs text-gray-500 flex items-center">
              {geoLoading
                ? "주소 변환 중..."
                : clickMode
                ? `지도 클릭 모드: ${clickMode}`
                : "지도 클릭 OFF"}
            </div>
          </div>

          <div className="text-xs text-gray-500 mb-1">도착지 검색(전국)</div>

          {/* ✅ relative 컨테이너 안에서 dropdown을 absolute로 띄움 */}
          <div
            className="relative"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="flex gap-2">
              <input
                value={dropoffQuery}
                onChange={(e) => setDropoffQuery(e.target.value)}
                className="flex-1 border rounded-xl px-3 py-2 text-sm"
                placeholder="예) 강릉역 / 서울역 / 인천시청"
                onFocus={() => {
                  if (dropoffResults.length) setShowDropoffResults(true);
                  setShowPickupResults(false);
                }}
              />
              <button
                onClick={doSearchDropoff}
                className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm"
                disabled={loading || geoLoading}
              >
                검색
              </button>
            </div>

            <ResultDropdown
  visible={showDropoffResults}
  items={dropoffResults}
  onPick={applyDropoffFromResult}
  onClose={() => setShowDropoffResults(false)}
  title="도착지 검색 결과"
/>

          </div>

          <div className="mt-3 text-xs text-gray-700">
            도착: <b>{dropoffText || "-"}</b>
          </div>
        </div>

        {/* 지도 */}
        <div className="rounded-2xl border bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">지도</div>
            <div className="text-xs text-gray-500">
              {clickMode
                ? `지도 클릭으로 ${clickMode === "pickup" ? "출발" : "도착"} 선택하세요`
                : "지도 클릭 OFF"}
            </div>
          </div>

          <MapViewClient
            pickup={mapPickup}
            dropoff={dropoff}
            clickMode={clickMode}
            onPickPickup={onPickPickupByMap}
            onPickDropoff={onPickDropoffByMap}
            showLine={true}
            followParticipant={false}
          />

          <div className="mt-3 text-xs text-gray-700">
            ✅ 요약
            <div className="mt-1">
              출발: <b>{pickupText || "-"}</b>
            </div>
            <div className="mt-1">
              도착: <b>{dropoffText || "-"}</b>
            </div>
          </div>
        </div>

        {/* 생성 */}
        <button
          onClick={createRequest}
          disabled={loading || geoLoading}
          className="px-5 py-3 rounded-xl bg-blue-600 text-white text-center disabled:opacity-60"
        >
          {loading ? "생성 중..." : geoLoading ? "주소 변환 중..." : "동행 요청 생성"}
        </button>
      </div>
    </main>
  );
}
