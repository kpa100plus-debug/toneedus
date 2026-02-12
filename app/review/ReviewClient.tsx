"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";

export default function ReviewClient() {
  const sp = useSearchParams();
  const router = useRouter();

  const role = sp.get("role") ?? "requester"; // requester | participant
  const id = sp.get("id") ?? "";

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");

  const subtitle = "동행 진행 경험을 알려주세요.";
  const placeholder =
    "요청/이동 과정에서 좋았던 점이나 개선이 필요한 점을 자유롭게 작성해주세요. (선택)";

  const handleSubmit = async () => {
    // 여기서 DB 저장 로직 넣으면 됨
    router.replace(`/review/complete?role=${encodeURIComponent(role)}&id=${encodeURIComponent(id)}`);
  };

  return (
    <main className="min-h-screen p-6 bg-white flex justify-center">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="text-xl font-extrabold mb-1">
            동행이 안전하게 완료되었습니다.
          </h1>
          <p className="text-sm text-gray-600">{subtitle}</p>
        </div>

        <div className="border rounded-xl p-4 text-sm text-gray-600">
          이 평가는 서비스 품질 관리를 위해서만 사용되며
          <br />
          외부에 공개되지 않습니다.
        </div>

        <div className="border rounded-xl p-4 space-y-4">
          <div>
            <div className="text-sm font-semibold mb-2">별점</div>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  className={`w-10 h-10 rounded-lg border ${
                    rating >= n ? "bg-yellow-200" : "bg-white"
                  }`}
                >
                  ★
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold mb-2">코멘트</div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={placeholder}
              className="w-full h-28 border rounded-lg p-3 text-sm"
            />
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold"
          >
            의견 전달 완료
          </button>

          <button
            type="button"
            onClick={() => router.replace("/")}
            className="w-full border py-3 rounded-xl text-sm"
          >
            건너뛰기
          </button>

          <div className="text-xs text-gray-400">요청 ID: {id}</div>
        </div>
      </div>
    </main>
  );
}
