import { Suspense } from "react";
import ReviewClient from "./ReviewClient";

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 p-6" />}>
      <ReviewClient />
    </Suspense>
  );
}
