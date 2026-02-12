export const dynamic = "force-dynamic";

import { Suspense } from "react";
import ReviewCompleteClient from "./ReviewCompleteClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 p-6" />}>
      <ReviewCompleteClient />
    </Suspense>
  );
}
