export const revalidate = 300;

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-orange-600">
            QR Attendance
          </p>
          <h1 className="max-w-2xl text-4xl font-semibold leading-tight sm:text-5xl">
            Take lecture attendance with a QR code that changes every 10 seconds.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-700">
            Lecturers project a rotating code; students scan it with their phone to
            check in. Because the code expires almost immediately, a screenshot
            passed to someone outside the room is useless by the time it arrives.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Lecturers</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Start a session from your dashboard, put the projector page on the
              big screen, and watch check-ins arrive live.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Students</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Scan the code on screen with your phone camera. Log in once and
              checking in takes a couple of seconds.
            </p>
          </div>
        </div>

        <nav className="flex flex-wrap gap-3">
          <a
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            href="/login"
          >
            Log in
          </a>
        </nav>
      </section>
    </main>
  );
}
