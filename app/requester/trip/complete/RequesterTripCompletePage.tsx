"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export default function RequesterTripCompleteClient() {
  const sp = useSearchParams();
  const id = sp.get("id") ?? "";
  const requestId = id || "-";

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="max-w-md mx-auto space-y-4">
        <div className="rounded-2xl border bg-white p-6 text-center">
          <h1 className="text-2xl font-bold mb-2">동행 종료 ✅</h1>

          <p className="text-sm text-gray-600">참여자가 동행을 종료했습니다.</p>

          <div className="mt-3 text-xs text-gray-500 break-all">
            요청 ID: {requestId}
          </div>
        </div>

        <Link
          href="/requester"
          className="block px-5 py-3 rounded-xl bg-blue-600 text-white text-center font-semibold"
        >
          새 동행 요청하기
        </Link>

        <Link
          href={id ? `/review?role=requester&id=${id}` : "/requester"}
          className="block px-5 py-3 rounded-xl bg-slate-900 text-white text-center font-semibold"
        >
          안전 동행 의견 보내기
        </Link>

        <Link href="/" className="block text-sm text-gray-600 underline text-center">
          홈으로
        </Link>
      </div>
    </main>
  );
}
