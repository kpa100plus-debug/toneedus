import { Suspense } from "react";
import ParticipantTripClient from "./ParticipantTripClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-gray-500">로딩중…</div>}>
      <ParticipantTripClient />
    </Suspense>
  );
}
