"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export default function ReviewCompleteClient() {
  const sp = useSearchParams();
  const role = sp.get("role") ?? "requester";

  const homeHref = role === "participant" ? "/participant" : "/requester";

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-md">
        <div className="rounded-2xl border bg-white p-6 text-center">
          <div className="mb-2 text-lg font-bold">소중한 의견 감사합니다.</div>
          <div className="text-sm text-gray-700">
            더 안전한 서비스를 만드는 데 반영하겠습니다.
          </div>

          <Link
            href={homeHref}
            className="mt-6 inline-block w-full rounded-xl bg-gray-900 py-3 font-semibold text-white"
          >
            확인
          </Link>
        </div>
      </div>
    </main>
  );
}
