import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const latStr = searchParams.get("lat");
    const lngStr = searchParams.get("lng");

    if (!latStr || !lngStr) {
      return NextResponse.json(
        { error: "lat and lng are required (e.g. ?lat=37.5665&lng=126.9780)" },
        { status: 400 }
      );
    }

    const lat = Number(latStr);
    const lng = Number(lngStr);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: "lat/lng must be valid numbers" },
        { status: 400 }
      );
    }

    const key = process.env.KAKAO_REST_API_KEY;
    if (!key) {
      return NextResponse.json(
        {
          error: "KAKAO_REST_API_KEY is missing",
          hint: "Put it in the project root .env.local (same level as package.json) and restart dev server.",
        },
        { status: 500 }
      );
    }

    // ✅ 카카오: x=경도(lng), y=위도(lat)
    const url = `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lng}&y=${lat}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `KakaoAK ${key}`,
      },
      cache: "no-store",
    });

    const data = await res.json();

    // ✅ 카카오가 에러를 준 경우(키 문제/쿼터 등)
    if (!res.ok) {
      return NextResponse.json(
        {
          error: "Kakao API error",
          status: res.status,
          kakao: data,
        },
        { status: 502 }
      );
    }

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Server error", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
