"use client";

import dynamic from "next/dynamic";

const MapView = dynamic(() => import("./MapViewClient"), { ssr: false });

export default MapView;
