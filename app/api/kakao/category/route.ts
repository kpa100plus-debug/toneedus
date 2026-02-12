import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const code = (searchParams.get("code") || "").trim(); // ex) SW8
    const lat = searchParams.get("lat");
    const lng = searchParams.get("lng");
    const radius = searchParams.get("radius") || "20000";

    if (!code || !lat || !lng) {
      return NextResponse.json({ documents: [] });
    }

    const key = process.env.KAKAO_REST_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "KAKAO_REST_API_KEY is missing" }, { status: 500 });
    }

    const params = new URLSearchParams({
      category_group_code: code,
      x: String(lng), // 경도
      y: String(lat), // 위도
      radius: String(radius),
      size: "15",
      sort: "distance",
    });

    const url = `https://dapi.kakao.com/v2/local/search/category.json?${params.toString()}`;

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
