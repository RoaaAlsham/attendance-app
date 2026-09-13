"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type Result =
  | { status: "loading" }
  | { status: "success" }
  | { status: "already" }
  | { status: "invalid"; reason?: string }
  | { status: "outside_geofence" }
  | { status: "rate_limited" }
  | { status: "session_ended" }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "error" }
  | { status: "missing_params" };

export default function AttendClient() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const token = searchParams.get("token");
  const [result, setResult] = useState<Result>({ status: "loading" });

  useEffect(() => {
    if (!sessionId || !token) {
      setResult({ status: "missing_params" });
      return;
    }
    submit(sessionId, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token]);

  async function submit(sessionId: string, token: string) {
    setResult({ status: "loading" });

    let lat: number | undefined;
    let lng: number | undefined;
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 }),
      );
      lat = position.coords.latitude;
      lng = position.coords.longitude;
    } catch {
      // geolocation is optional — continue the check-in without it
    }

    const res = await fetch("/api/attend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, token, lat, lng }),
    });

    if (res.status === 201) return setResult({ status: "success" });
    if (res.status === 409) return setResult({ status: "already" });
    if (res.status === 401) return setResult({ status: "unauthorized" });
    if (res.status === 403) return setResult({ status: "forbidden" });
    if (res.status === 410) return setResult({ status: "session_ended" });
    if (res.status === 429) return setResult({ status: "rate_limited" });
    if (res.status === 422) {
      const data = (await res.json()) as { error?: string; reason?: string };
      if (data.error === "outside_geofence") return setResult({ status: "outside_geofence" });
      return setResult({ status: "invalid", reason: data.reason });
    }
    setResult({ status: "error" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-center text-slate-950">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-slate-200 bg-white p-8">
        {result.status === "loading" && <p className="text-lg font-medium">Checking in…</p>}

        {result.status === "success" && (
          <>
            <p className="text-3xl">✅</p>
            <p className="text-lg font-medium">You&apos;re checked in</p>
          </>
        )}

        {result.status === "already" && (
          <>
            <p className="text-3xl">ℹ️</p>
            <p className="text-lg font-medium">Already recorded</p>
            <p className="text-sm text-slate-600">You&apos;ve already checked in to this session.</p>
          </>
        )}

        {result.status === "invalid" && (
          <>
            <p className="text-3xl">⚠️</p>
            <p className="text-lg font-medium">
              {result.reason === "expired" ? "This QR code expired" : "Invalid QR code"}
            </p>
            <p className="text-sm text-slate-600">Ask the lecturer for a fresh code, then scan again.</p>
          </>
        )}

        {result.status === "outside_geofence" && (
          <>
            <p className="text-3xl">📍</p>
            <p className="text-lg font-medium">You&apos;re too far from the room</p>
            <p className="text-sm text-slate-600">Move closer to the lecture room, then scan again.</p>
          </>
        )}

        {result.status === "rate_limited" && (
          <>
            <p className="text-3xl">⏳</p>
            <p className="text-lg font-medium">Too many attempts</p>
            <p className="text-sm text-slate-600">Wait a moment, then try again.</p>
          </>
        )}

        {result.status === "session_ended" && (
          <>
            <p className="text-3xl">⚠️</p>
            <p className="text-lg font-medium">This session has ended</p>
          </>
        )}

        {result.status === "unauthorized" && (
          <>
            <p className="text-3xl">🔒</p>
            <p className="text-lg font-medium">Log in to check in</p>
            <a href="/login" className="text-sm text-slate-700 underline">
              Log in
            </a>
          </>
        )}

        {result.status === "forbidden" && (
          <>
            <p className="text-3xl">🔒</p>
            <p className="text-lg font-medium">Only students can check in</p>
          </>
        )}

        {result.status === "missing_params" && (
          <>
            <p className="text-3xl">⚠️</p>
            <p className="text-lg font-medium">Missing scan details</p>
            <p className="text-sm text-slate-600">Scan the QR code again from the projector screen.</p>
          </>
        )}

        {result.status === "error" && (
          <>
            <p className="text-3xl">⚠️</p>
            <p className="text-lg font-medium">Something went wrong</p>
            <button
              onClick={() => sessionId && token && submit(sessionId, token)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
