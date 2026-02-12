import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6">
      <h1 className="text-4xl font-bold mb-4">삐삐캅</h1>
      <p className="text-gray-600 mb-8">생활 속 안심동행 플랫폼 (2대 데모)</p>

      <div className="flex gap-4">
        <Link
          href="/requester"
          className="px-6 py-3 rounded-xl bg-blue-600 text-white text-lg"
        >
          안심동행 신청 (요청자)
        </Link>

        <Link
          href="/participant"
          className="px-6 py-3 rounded-xl bg-green-600 text-white text-lg"
        >
          동행 참여 (참여자)
        </Link>
      </div>
    </main>
  );
}
