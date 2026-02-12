import { Suspense } from "react";
import RequesterTripClient from "./RequesterTripClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">로딩중...</div>}>
      <RequesterTripClient />
    </Suspense>
  );
}