"use client";

import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";

export default function ParticipantTripCompleteClient() {
  const sp = useSearchParams();
  const router = useRouter();

  const id = sp.get("id") ?? "";

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="max-w-md mx-auto grid gap-4">
        <div className="rounded-2xl border bg-white p-6 text-center">
          <div className="text-xl font-bold">동행 종료 ✅</div>
          <div className="text-sm text-gray-600 mt-2">
            동행이 종료되었습니다.
          </div>

          <div className="text-xs text-gray-500 mt-3 break-all">
            요청 ID: {id || "-"}
          </div>
        </div>

        {/* ✅ 참여자도 “자동으로 평가로 보내지 말고” 선택 버튼으로 가는 걸 추천 */}
        <button
          onClick={() => router.push(`/review?role=participant&id=${id}`)}
          className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold"
        >
          안전 동행 의견 보내기
        </button>

        <Link
          href="/participant"
          className="w-full py-3 rounded-xl border bg-white text-center font-semibold"
        >
          목록으로
        </Link>
      </div>
    </main>
  );
}
