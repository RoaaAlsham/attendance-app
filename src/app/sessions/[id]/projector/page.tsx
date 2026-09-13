"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";

interface SessionDetails {
  id: string;
  courseName: string;
  courseCode: string;
  endedAt: number | null;
}

interface AttendanceEntry {
  id: string;
  name: string;
}

export default function ProjectorPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionDetails | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceEntry[]>([]);
  const [ending, setEnding] = useState(false);
  const nextLocalId = useRef(0);

  useEffect(() => {
    fetch(`/api/sessions/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setSession(data));

    fetch(`/api/sessions/${id}/attendance`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: { id: string; name: string }[]) =>
        setAttendance(rows.map((row) => ({ id: row.id, name: row.name }))),
      );
  }, [id]);

  useEffect(() => {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const projectorSocket = new WebSocket(
      `${wsProtocol}//${window.location.host}/api/sessions/${id}/ws?role=projector`,
    );
    projectorSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as { type: string; token?: string };
      if (message.type === "qr" && message.token) {
        const url = `${window.location.origin}/attend?session=${id}&token=${message.token}`;
        QRCode.toDataURL(url).then(setQrDataUrl);
      }
    });

    const lecturerSocket = new WebSocket(
      `${wsProtocol}//${window.location.host}/api/sessions/${id}/ws?role=lecturer`,
    );
    lecturerSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as { type: string; studentName?: string };
      if (message.type === "attendance") {
        nextLocalId.current += 1;
        setAttendance((current) => [
          ...current,
          { id: `live-${nextLocalId.current}`, name: message.studentName ?? "Unknown" },
        ]);
      }
    });

    return () => {
      projectorSocket.close();
      lecturerSocket.close();
    };
  }, [id]);

  async function handleEndSession() {
    setEnding(true);
    const res = await fetch(`/api/sessions/${id}/end`, { method: "POST" });
    if (res.ok) {
      setSession((current) => (current ? { ...current, endedAt: Date.now() / 1000 } : current));
    }
    setEnding(false);
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
      <section className="mx-auto flex max-w-3xl flex-col items-center gap-8">
        <div className="text-center">
          <p className="text-sm uppercase tracking-wide text-slate-400">
            {session ? `${session.courseCode} — ${session.courseName}` : "Loading…"}
          </p>
          {session?.endedAt && <p className="mt-1 text-amber-400">Session ended</p>}
        </div>

        {qrDataUrl && !session?.endedAt && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrDataUrl} alt="Scan to check in" className="h-80 w-80 rounded-lg bg-white p-4" />
        )}

        <button
          onClick={handleEndSession}
          disabled={ending || !!session?.endedAt}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-500 disabled:opacity-50"
        >
          {session?.endedAt ? "Session ended" : ending ? "Ending…" : "End session"}
        </button>

        <div className="w-full rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">
            Attendance ({attendance.length})
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-slate-300">
            {attendance.map((entry) => (
              <li key={entry.id}>{entry.name}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
