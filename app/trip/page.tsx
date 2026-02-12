import { Suspense } from "react";
import TripClient from "./TripClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen p-6 bg-gray-50" />}>
      <TripClient />
    </Suspense>
  );
}
