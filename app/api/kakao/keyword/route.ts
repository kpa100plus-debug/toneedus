import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const q = (searchParams.get("q") || "").trim();
    const lat = searchParams.get("lat"); // optional
    const lng = searchParams.get("lng"); // optional
    const radiusRaw = searchParams.get("radius"); // optional

    if (!q || q.length < 2) {
      return NextResponse.json({ documents: [] });
    }

    const key = process.env.KAKAO_REST_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "KAKAO_REST_API_KEY missing" }, { status: 500 });
    }

    // ✅ 카카오 radius 최대 20000m (20km)
    let radius = 20000;
    if (radiusRaw) {
      const n = Number(radiusRaw);
      if (!Number.isNaN(n)) radius = Math.min(Math.max(n, 0), 20000);
    }

    // ✅ 전국 검색(넓게)은 x/y/radius를 아예 빼야 함
    const params = new URLSearchParams({
      query: q,
      size: "10",
    });

    // lat/lng가 둘 다 있을 때만 위치 가중치 적용
    if (lat && lng) {
      params.set("y", String(lat)); // 위도
      params.set("x", String(lng)); // 경도
      params.set("radius", String(radius));
      params.set("sort", "distance");
    } else {
      // 전국 검색은 정확도/관련도
      params.set("sort", "accuracy");
    }

    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`;

    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${key}` },
      cache: "no-store",
    });

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ documents: [], error: e?.message ?? String(e) }, { status: 500 });
  }
}
