# Attendance App

A QR-code-based lecture attendance system. A lecturer starts a session and
projects a QR code that rotates every ~10 seconds; students scan it with
their phone to check in. Built on Next.js (App Router) running on Cloudflare
Workers via [vinext](https://vinext.dev/), with D1 for storage and a Durable
Object driving the rotating token / live attendance feed.

See `attendance-app-implementation-plan(1).md` (git-ignored, local only) for
the full phased implementation plan this project follows.

## Stack

- **Next.js (App Router)** served through **vinext**, Cloudflare's Vite
  plugin that reimplements the Next.js API surface directly on workerd —
  no Node.js server, no separate build-then-adapt step.
- **D1** (SQLite at the edge) for relational data: users, courses, sessions,
  attendance records.
- **Durable Objects** (added in a later phase) for the rotating QR token and
  the live WebSocket feed to the projector/dashboard.
- **Wrangler** for local dev bindings, migrations, and deployment.

## Project status

- ✅ **Phase 0 — Environment setup**: project scaffolded with vinext,
  Cloudflare Workers as the deploy target, D1 bound (`DB`), `wrangler dev`
  runs cleanly.
- ✅ **Phase 1 — Data model & D1 schema**: schema migrated locally.
- ✅ **Phase 2 — Next.js app scaffold & routing**: every API endpoint exists
  as a Route Handler (this phase — see below).
- ⬜ Phase 3 — Authentication
- ⬜ Phase 4 — Durable Object + custom worker
- ⬜ Phase 5 — Lecturer flow (pages)
- ⬜ Phase 6 — Student flow (pages)
- ⬜ Phase 7 — Anti-fraud checks
- ⬜ Phase 8 — Testing & deployment

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` runs the vinext dev server on top of Miniflare/workerd, so D1
and (later) Durable Object bindings are live from the very first request —
there's no separate "UI-only" dev mode to worry about.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the vinext dev server (local workerd runtime, bindings live). |
| `npm run build` | Build the Cloudflare Worker output. |
| `npm run start` | Run the built Worker locally via Wrangler. |
| `npm run deploy` | Deploy to Cloudflare Workers. |

## Data model

Defined in [migrations/0001_init.sql](migrations/0001_init.sql) and applied
with Wrangler's D1 migration tooling.

| Table | Purpose |
|---|---|
| `users` | Lecturers and students. `role` is constrained to `student` \| `lecturer`. |
| `courses` | Owned by a lecturer (`lecturer_id`). |
| `sessions` | One lecture session for a course; optionally carries room coordinates (`room_lat`/`room_lng`) and a check-in radius (`radius_m`) for the Phase 7 geofence check. |
| `attendance` | One row per student check-in. `UNIQUE(session_id, user_id)` enforces "one scan per student per session" at the database level. |

### Working with migrations

```bash
# apply all pending migrations to the local D1 instance
npx wrangler d1 migrations apply attendance --local

# same, against the remote (production) database — do this in Phase 8
npx wrangler d1 migrations apply attendance --remote

# run an ad-hoc query against the local DB
npx wrangler d1 execute attendance --local --command "SELECT * FROM users"
```

Add new schema changes as a new `migrations/000N_description.sql` file —
never edit an already-applied migration file.

### Seed data

[scripts/seed.sql](scripts/seed.sql) inserts one lecturer and one student for
local testing:

```bash
npx wrangler d1 execute attendance --local --file=./scripts/seed.sql
```

Their `password_hash` values are placeholders (`'placeholder-hash'`) — real
password hashing lands in Phase 3, at which point these rows should be
re-seeded with real hashes (or signed up through the API instead).

| Role | Email | id |
|---|---|---|
| lecturer | lecturer@example.com | `11111111-1111-1111-1111-111111111111` |
| student | student@example.com | `22222222-2222-2222-2222-222222222222` |

### Verifying the schema

```bash
# list tables
npx wrangler d1 execute attendance --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"
```

A duplicate `(session_id, user_id)` insert into `attendance` is rejected with
`UNIQUE constraint failed` — this has been verified manually and is the
invariant later phases (the `/api/attend` route) rely on to detect
"already scanned" instead of racing on application logic.

## API routes

Every endpoint from the plan exists as a Route Handler under `app/api/`.
Everything except `/api/health` is currently a stub returning
`501 { "error": "not implemented" }` — real logic lands in Phases 3, 5, 6,
and 7. There is deliberately no route for the WebSocket channel
(`/api/sessions/:id/ws`); Phase 4 handles that in a custom worker entry
(`worker/index.ts`) that intercepts it before the request reaches Next.js
routing.

| Method | Path | Status |
|---|---|---|
| GET | `/api/health` | ✅ implemented — runs `SELECT 1` against `env.DB` as a binding smoke test |
| POST | `/api/auth/signup` | stub |
| POST | `/api/auth/login` | stub |
| POST | `/api/auth/logout` | stub |
| GET | `/api/me` | stub |
| POST | `/api/courses` | stub |
| GET | `/api/courses` | stub |
| POST | `/api/sessions` | stub |
| GET | `/api/sessions/:id` | stub |
| POST | `/api/sessions/:id/end` | stub |
| GET | `/api/sessions/:id/attendance` | stub |
| POST | `/api/attend` | stub |

Bindings (D1, and later KV/DO) are read directly via
`import { env } from "cloudflare:workers"` inside route handlers — no
wrapper/adapter layer, since vinext exposes bindings natively in both dev
and production.

Verified manually against `npm run dev`: every route above responds (200 for
`/api/health`, 501 for the stubs), and requesting an unmapped path (e.g.
`/api/does-not-exist`) renders Next.js's normal 404 page rather than a
worker-level error.

## Configuration notes

- The D1 binding in `wrangler.jsonc` is named `DB` (matching `env.DB` used
  throughout the plan/codebase) — this was renamed from the scaffold
  default during Phase 1 for consistency with later phases.
- Run `npx wrangler types` after any change to `wrangler.jsonc` bindings to
  keep `worker-configuration.d.ts`'s `Env` type in sync.
