export async function reverseGeocodeOSM(lat: number, lng: number) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  
    const res = await fetch(url, {
      headers: {
        // Nominatim은 User-Agent 권장(브라우저에서는 제한이 있으니 referrer 정도만)
        "Accept": "application/json",
      },
    });
  
    if (!res.ok) throw new Error("역지오코딩 실패: " + res.status);
    const data = await res.json();
  
    // display_name이 가장 무난
    return (data?.display_name as string) ?? "";
  }
  