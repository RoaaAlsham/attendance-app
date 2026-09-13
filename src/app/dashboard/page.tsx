"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Course {
  id: string;
  name: string;
  code: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseCode, setNewCourseCode] = useState("");
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    loadCourses();
  }, []);

  async function loadCourses() {
    const res = await fetch("/api/courses");
    if (!res.ok) return;
    const data = (await res.json()) as Course[];
    setCourses(data);
    setCourseId((current) => current || data[0]?.id || "");
  }

  async function handleCreateCourse(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCourseName, code: newCourseCode }),
    });
    if (!res.ok) {
      setError("Could not create course.");
      return;
    }
    setNewCourseName("");
    setNewCourseCode("");
    await loadCourses();
  }

  function captureLocation() {
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setLocationError("Could not get your location."),
    );
  }

  async function handleStartSession(e: React.FormEvent) {
    e.preventDefault();
    if (!courseId) return;
    setStarting(true);
    setError(null);

    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId,
        roomLat: location?.lat,
        roomLng: location?.lng,
      }),
    });

    if (!res.ok) {
      setStarting(false);
      setError("Could not start session.");
      return;
    }

    const { id } = (await res.json()) as { id: string };
    router.push(`/sessions/${id}/projector`);
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto flex max-w-xl flex-col gap-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>

        <form
          onSubmit={handleStartSession}
          className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5"
        >
          <h2 className="font-semibold">Start a session</h2>

          <label className="flex flex-col gap-1 text-sm">
            Course
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2"
            >
              {courses.length === 0 && <option value="">No courses yet</option>}
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code} — {course.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={captureLocation}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-100"
            >
              Capture room location
            </button>
            {location && (
              <span className="text-slate-600">
                {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
              </span>
            )}
            {locationError && <span className="text-red-600">{locationError}</span>}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={starting || !courseId}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {starting ? "Starting…" : "Start session"}
          </button>
        </form>

        <form
          onSubmit={handleCreateCourse}
          className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5"
        >
          <h2 className="font-semibold">New course</h2>
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              required
              value={newCourseName}
              onChange={(e) => setNewCourseName(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Code
            <input
              required
              value={newCourseCode}
              onChange={(e) => setNewCourseCode(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
          >
            Add course
          </button>
        </form>
      </section>
    </main>
  );
}
