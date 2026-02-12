"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

type ReqRow = {
  id: string;
  status: string;
  pickup_text: string | null;
  dropoff_text: string | null;
  requester_label: string | null;
  participant_label: string | null;
  created_at: string;
};

export default function TripCompleteClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [row, setRow] = useState<ReqRow | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!id) return;

    const run = async () => {
      const { data, error } = await supabase
        .from("requests")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        setErrorMsg(error.message);
        return;
      }
      setErrorMsg("");
      setRow(data as ReqRow);
    };

    run();
  }, [id]);

  return (
    <main className="min-h-screen p-6 bg-gray-50">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">이동 완료</h1>
        <Link href="/" className="text-sm text-gray-600 underline">
          홈으로
        </Link>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl border bg-white max-w-md text-red-600">
          {errorMsg}
        </div>
      )}

      <div className="max-w-md space-y-4">
        <div className="rounded-2xl border bg-white p-4">
          <div className="text-lg font-semibold">종료되었습니다 ✅</div>
          <div className="mt-3 text-sm text-gray-700 space-y-1">
            <div>요청자: <b>{row?.requester_label ?? "-"}</b></div>
            <div>참여자: <b>{row?.participant_label ?? "-"}</b></div>
            <div>출발지: {row?.pickup_text ?? "-"}</div>
            <div>도착지: {row?.dropoff_text ?? "-"}</div>
          </div>
          <div className="mt-3 text-sm text-gray-600">
            최종 상태: <b>{row?.status ?? "loading..."}</b>
          </div>
          <div className="mt-2 text-xs text-gray-500 break-all">
            request id: {id ?? "-"}
          </div>
        </div>

        <Link
          href="/"
          className="block px-5 py-3 rounded-xl bg-blue-600 text-white text-center"
        >
          홈으로 돌아가기
        </Link>
      </div>
    </main>
  );
}

