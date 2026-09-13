import { Suspense } from "react";
import AttendClient from "./attend-client";

export default function AttendPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-50" />}>
      <AttendClient />
    </Suspense>
  );
}
