"use client";

import { useEffect, useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  CircleMarker,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type LatLng = [number, number];

type Props = {
  pickup: LatLng;
  dropoff?: LatLng | null;
  participant?: LatLng | null;
  participantPath?: LatLng[] | null;

  showLine?: boolean;
  followParticipant?: boolean;
  followPickup?: boolean;


  // ✅ 지도 클릭 선택(출발/도착)
  clickMode?: "pickup" | "dropoff" | null;
  onPickPickup?: (pos: LatLng) => void;
  onPickDropoff?: (pos: LatLng) => void;

  // ✅ 이전 호환(도착만 선택)
  selectDropoff?: boolean;
  onSelectDropoff?: (pos: LatLng) => void;

  // ✅ 접근중/도착 강조
  showApproachingBadge?: boolean; // 기본 true로 써도 됨
  approaching?: boolean; // true면 참여자 핀 위에 펄스
  arrived?: boolean; // true면 도착지 강조
};

function AutoFollow({
  target,
}: {
  target: LatLng | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;
    map.setView(target, map.getZoom(), { animate: true });
  }, [target, map]);

  return null;
}

function ClickPicker({
  mode,
  onPickPickup,
  onPickDropoff,
  onSelectDropoff,
}: {
  mode: "pickup" | "dropoff" | null;
  onPickPickup?: (pos: LatLng) => void;
  onPickDropoff?: (pos: LatLng) => void;
  onSelectDropoff?: (pos: LatLng) => void;
}) {
  useMapEvents({
    click(e) {
      if (!mode) return;
      const pos: LatLng = [e.latlng.lat, e.latlng.lng];

      if (mode === "pickup") onPickPickup?.(pos);
      if (mode === "dropoff") {
        onPickDropoff?.(pos);
        onSelectDropoff?.(pos); // ✅ 호환
      }
    },
  });

  return null;
}

// ✅ 기본 마커 아이콘 깨짐 방지
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ✅ 컬러 마커(블루/레드/그린)
const pickupIcon = new L.Icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const dropoffRedIcon = new L.Icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const participantGreenIcon = new L.Icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export default function MapViewClient({
  pickup,
  dropoff = null,
  participant = null,
  participantPath = null,
  showLine = false,
  followParticipant = false,

  clickMode = null,
  onPickPickup,
  onPickDropoff,

  selectDropoff,
  onSelectDropoff,

  showApproachingBadge = true,
  approaching = false,
  arrived = false,
}: Props) {
  // ✅ 이전 props 호환: selectDropoff가 true면 dropoff 클릭모드로 동작
  const mode: "pickup" | "dropoff" | null = useMemo(() => {
    if (clickMode) return clickMode;
    if (selectDropoff) return "dropoff";
    return null;
  }, [clickMode, selectDropoff]);

  // ✅ 자동 따라가기(참여자 우선, 없으면 출발)
  const followTarget = useMemo<LatLng>(() => {
    if (followParticipant && participant) return participant;
    return pickup;
  }, [followParticipant, participant, pickup]);

  const showPath = participantPath && participantPath.length >= 2;

  return (
    <div className="w-full">
      {/* ✅ 애니메이션 CSS */}
      <style jsx global>{`
        @keyframes bbcopPulse {
          0% {
            transform: scale(0.7);
            opacity: 0.65;
          }
          70% {
            transform: scale(1.8);
            opacity: 0;
          }
          100% {
            transform: scale(1.8);
            opacity: 0;
          }
        }
        .bbcop-pulse {
          animation: bbcopPulse 1.4s ease-out infinite;
        }
        .bbcop-arrived {
          animation: bbcopPulse 1.2s ease-out infinite;
        }
      `}</style>

      <MapContainer
        center={pickup}
        zoom={15}
        scrollWheelZoom={true}
        className="h-[260px] w-full rounded-xl"
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* ✅ 지도 클릭 선택 */}
        <ClickPicker
          mode={mode}
          onPickPickup={onPickPickup}
          onPickDropoff={onPickDropoff}
          onSelectDropoff={onSelectDropoff}
        />

        {/* ✅ 출발 */}
        <Marker position={pickup} icon={pickupIcon} />

        {/* ✅ 도착 */}
        {dropoff && <Marker position={dropoff} icon={dropoffRedIcon} />}

        {/* ✅ 선(출발-도착) */}
        {showLine && dropoff && <Polyline positions={[pickup, dropoff]} />}

        {/* ✅ 참여자 */}
        {participant && <Marker position={participant} icon={participantGreenIcon} />}

        {/* ✅ 참여자 동선 */}
        {showPath && <Polyline positions={participantPath as LatLng[]} />}

        {/* ✅ “접근 중” 애니메이션(참여자 핀 위 펄스) */}
        {showApproachingBadge && participant && approaching && (
          <CircleMarker
            center={participant}
            radius={18}
            className="bbcop-pulse"
            pathOptions={{}}
          />
        )}

        {/* ✅ 목적지 도착 강조(도착지 펄스) */}
        {dropoff && arrived && (
          <CircleMarker
            center={dropoff}
            radius={22}
            className="bbcop-arrived"
            pathOptions={{}}
          />
        )}

        {/* ✅ 자동 따라가기 */}
        <AutoFollow target={followTarget} />
      </MapContainer>
    </div>
  );
}
