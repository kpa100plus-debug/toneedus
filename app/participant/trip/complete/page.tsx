import { Suspense } from "react";
import ParticipantTripCompleteClient from "./ParticipantTripCompleteClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">로딩중…</div>}>
      <ParticipantTripCompleteClient />
    </Suspense>
  );
}
