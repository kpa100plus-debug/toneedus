import { Suspense } from "react";
import TripCompleteClient from "./TripCompleteClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen p-6 bg-gray-50" />}>
      <TripCompleteClient />
    </Suspense>
  );
}

