"use client";

import dynamic from "next/dynamic";

const RequesterAcceptedClient = dynamic(
  () => import("./RequesterAcceptedClient"),
  { ssr: false }
);

export default function Page() {
  return <RequesterAcceptedClient />;
}
