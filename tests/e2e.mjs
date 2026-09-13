// Comprehensive end-to-end test for the attendance app (Phase 8).
// Exercises auth, courses, sessions, the Durable Object WS channel, the
// attend flow, role/ownership enforcement, anti-fraud checks, and concurrency.
//
// Usage: node e2e.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://localhost:3000";
const WS_BASE = BASE.replace(/^http/, "ws");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const uniq = Date.now().toString(36);
const cookies = new Map(); // label -> session cookie value

async function api(path, { method = "GET", body, as, ip, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (as && cookies.has(as)) headers["Cookie"] = `session=${cookies.get(as)}`;
  if (raw) headers["Cookie"] = `session=${raw}`;
  if (ip) headers["CF-Connecting-IP"] = ip;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

async function signup(label, role) {
  const email = `e2e-${label}-${uniq}@example.com`;
  const r = await api("/api/auth/signup", {
    method: "POST",
    body: { name: `E2E ${label}`, email, password: "testpass123", role },
  });
  if (r.status !== 201) throw new Error(`signup ${label} failed: ${r.status} ${JSON.stringify(r.data)}`);
  return { email, id: r.data.id };
}

async function login(label, email) {
  const r = await api("/api/auth/login", { method: "POST", body: { email, password: "testpass123" } });
  if (r.status !== 200) throw new Error(`login ${label} failed: ${r.status} ${JSON.stringify(r.data)}`);
  const token = /session=([^;]+)/.exec(r.setCookie ?? "")?.[1];
  if (!token) throw new Error(`login ${label}: no session cookie`);
  cookies.set(label, token);
  return { token, user: r.data };
}

// Opens a WS to the session and collects messages. Resolves once open.
// `as` picks whose session cookie to present (sockets are owner-authenticated).
function openSocket(sessionId, role, as = "lecturer") {
  const cookie = cookies.get(as);
  const ws = new WebSocket(`${WS_BASE}/api/sessions/${sessionId}/ws?role=${role}`, {
    headers: cookie ? { Cookie: `session=${cookie}` } : {},
  });
  const messages = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    messages.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () =>
      resolve({
        ws,
        messages,
        close: () => ws.close(),
        // wait for the next message matching a predicate (or use an already-received one)
        next(predicate, timeoutMs = 15000) {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timed out waiting for message`)), timeoutMs);
            const handler = (msg) => {
              if (predicate(msg)) {
                clearTimeout(timer);
                res(msg);
              } else {
                waiters.push(handler);
              }
            };
            waiters.push(handler);
          });
        },
        // wait until `count` messages matching predicate have arrived
        async untilCount(predicate, count, timeoutMs = 15000) {
          const deadline = Date.now() + timeoutMs;
          while (messages.filter(predicate).length < count && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
          return messages.filter(predicate);
        },
      }),
    );
    ws.addEventListener("error", reject);
    setTimeout(() => reject(new Error("ws open timeout")), 30000);
  });
}

// Tries to open a socket with a given cookie (or none) and reports whether any
// qr token leaked through before it was closed/rejected.
function probeSocket(sessionId, role, cookie, waitMs = 6000) {
  return new Promise((resolve) => {
    const messages = [];
    let ws;
    try {
      ws = new WebSocket(`${WS_BASE}/api/sessions/${sessionId}/ws?role=${role}`, {
        headers: cookie ? { Cookie: `session=${cookie}` } : {},
      });
    } catch {
      return resolve({ gotQr: false, messages });
    }
    ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));
    ws.addEventListener("error", () => resolve({ gotQr: messages.some((m) => m.type === "qr"), messages }));
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ gotQr: messages.some((m) => m.type === "qr"), messages });
    }, waitMs);
  });
}

// Grabs a guaranteed-fresh token: waits for the NEXT qr broadcast rather than
// reusing one that may already be seconds old.
// 35s, not ~10s: local Miniflare alarm delivery jitters well past the nominal
// 10s TTL under load (observed up to ~16s), so a tight bound flakes.
async function freshToken(socket, timeoutMs = 35000) {
  const before = socket.messages.filter((m) => m.type === "qr").length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const qrs = socket.messages.filter((m) => m.type === "qr");
    if (qrs.length > before) return qrs[qrs.length - 1].token;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no fresh token arrived");
}

async function main() {
  console.log(`Running E2E against ${BASE}\n`);

  // ---------------------------------------------------------------- health
  section("Health & routing");
  const health = await api("/api/health");
  check("GET /api/health returns 200 and reaches D1", health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));
  const notFound = await api("/api/does-not-exist");
  check("unknown API path returns 404", notFound.status === 404, `got ${notFound.status}`);

  // ------------------------------------------------------------------ auth
  section("Authentication");
  const lecturer = await signup("lecturer", "lecturer");
  const lecturer2 = await signup("lecturer2", "lecturer");
  const student = await signup("student", "student");

  const dupe = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "dupe", email: lecturer.email, password: "testpass123", role: "lecturer" },
  });
  check("duplicate signup email returns 409", dupe.status === 409, `got ${dupe.status}`);

  const badRole = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "x", email: `bad-${uniq}@example.com`, password: "p", role: "admin" },
  });
  check("invalid role returns 400", badRole.status === 400, `got ${badRole.status}`);

  const wrongPass = await api("/api/auth/login", { method: "POST", body: { email: lecturer.email, password: "nope" } });
  check("wrong password returns 401", wrongPass.status === 401, `got ${wrongPass.status}`);

  await login("lecturer", lecturer.email);
  await login("lecturer2", lecturer2.email);
  const studentLogin = await login("student", student.email);

  const me = await api("/api/me", { as: "lecturer" });
  check("GET /api/me returns the logged-in user", me.status === 200 && me.data?.email === lecturer.email, JSON.stringify(me.data));
  check("GET /api/me does not leak password_hash", me.status === 200 && me.data?.password_hash === undefined);

  const noCookie = await api("/api/me");
  check("GET /api/me without cookie returns 401", noCookie.status === 401, `got ${noCookie.status}`);

  // ----------------------------------------------------------- revocation
  section("Session revocation (Phase 3)");
  const throwaway = await signup("throwaway", "student");
  const throwawayLogin = await login("throwaway", throwaway.email);
  const capturedCookie = throwawayLogin.token;

  const beforeLogout = await api("/api/me", { raw: capturedCookie });
  check("captured cookie works before logout", beforeLogout.status === 200, `got ${beforeLogout.status}`);

  await api("/api/auth/logout", { method: "POST", raw: capturedCookie });
  const afterLogout = await api("/api/me", { raw: capturedCookie });
  check("replaying the exact captured cookie after logout returns 401", afterLogout.status === 401, `got ${afterLogout.status}`);

  // --------------------------------------------------------------- courses
  section("Courses");
  const course = await api("/api/courses", { method: "POST", as: "lecturer", body: { name: "E2E Course", code: `E2E${uniq}` } });
  check("lecturer can create a course", course.status === 201, `got ${course.status}`);
  const courseId = course.data?.id;

  const studentCreate = await api("/api/courses", { method: "POST", as: "student", body: { name: "x", code: "x" } });
  check("student creating a course returns 403", studentCreate.status === 403, `got ${studentCreate.status}`);

  const list = await api("/api/courses", { as: "lecturer" });
  check("lecturer sees own course in list", list.status === 200 && list.data.some((c) => c.id === courseId));

  const otherList = await api("/api/courses", { as: "lecturer2" });
  check("other lecturer does NOT see it (scoped to owner)", otherList.status === 200 && !otherList.data.some((c) => c.id === courseId));

  const badCourse = await api("/api/courses", { method: "POST", as: "lecturer", body: { name: "no code" } });
  check("creating a course without a code returns 400", badCourse.status === 400, `got ${badCourse.status}`);

  // -------------------------------------------------------------- sessions
  section("Sessions");
  const sessionRes = await api("/api/sessions", { method: "POST", as: "lecturer", body: { courseId } });
  check("lecturer can start a session", sessionRes.status === 201, `got ${sessionRes.status}`);
  const sessionId = sessionRes.data?.id;

  const foreignSession = await api("/api/sessions", { method: "POST", as: "lecturer2", body: { courseId } });
  check("lecturer cannot start a session on another lecturer's course", foreignSession.status === 404, `got ${foreignSession.status}`);

  const studentSession = await api("/api/sessions", { method: "POST", as: "student", body: { courseId } });
  check("student starting a session returns 403", studentSession.status === 403, `got ${studentSession.status}`);

  const detail = await api(`/api/sessions/${sessionId}`, { as: "student" });
  check("any authenticated user can read session details", detail.status === 200 && detail.data?.courseName === "E2E Course", JSON.stringify(detail.data));

  const foreignRoster = await api(`/api/sessions/${sessionId}/attendance`, { as: "lecturer2" });
  check("non-owning lecturer cannot read the roster", foreignRoster.status === 403, `got ${foreignRoster.status}`);

  const studentRoster = await api(`/api/sessions/${sessionId}/attendance`, { as: "student" });
  check("student cannot read the roster", studentRoster.status === 403, `got ${studentRoster.status}`);

  // ------------------------------------------------------- websocket + QR
  section("Durable Object / WebSocket");
  const projector = await openSocket(sessionId, "projector");
  const lecturerSocket = await openSocket(sessionId, "lecturer");
  check("projector WS connects", projector.ws.readyState === 1);
  check("lecturer WS connects", lecturerSocket.ws.readyState === 1);

  const firstQr = await projector.next((m) => m.type === "qr");
  check("projector receives an initial qr token", typeof firstQr.token === "string" && firstQr.token.length > 0);

  const secondToken = await freshToken(projector);
  check("token rotates to a new value", secondToken !== firstQr.token, `${firstQr.token} vs ${secondToken}`);

  const badWsRole = await fetch(`${BASE}/api/sessions/${sessionId}/ws?role=hacker`, {
    headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "x3JJHMbDL1EzLkh9GBhXDw==", Cookie: `session=${cookies.get("lecturer")}` },
  }).then((r) => r.status).catch(() => "connection-error");
  check("WS with an invalid role is rejected (not upgraded)", badWsRole !== 101, `got ${badWsRole}`);

  // The WS upgrade bypasses Next.js middleware, so it must authenticate itself.
  // Without this, anyone with a session id could harvest live QR tokens.
  const anonSocket = await probeSocket(sessionId, "projector", null);
  check("anonymous WS cannot subscribe to the QR feed", !anonSocket.gotQr, `messages: ${JSON.stringify(anonSocket.messages)}`);

  const studentSocket = await probeSocket(sessionId, "projector", cookies.get("student"));
  check("a student's WS cannot subscribe to the QR feed", !studentSocket.gotQr, `messages: ${JSON.stringify(studentSocket.messages)}`);

  const foreignSocket = await probeSocket(sessionId, "lecturer", cookies.get("lecturer2"));
  check("a non-owning lecturer's WS cannot subscribe", !foreignSocket.gotQr, `messages: ${JSON.stringify(foreignSocket.messages)}`);

  // ---------------------------------------------------------------- attend
  section("Attend flow");
  const liveToken = await freshToken(projector);
  const scan = await api("/api/attend", {
    method: "POST",
    as: "student",
    ip: "10.0.0.1",
    body: { sessionId, token: liveToken, lat: 1.23, lng: 4.56 },
  });
  check("fresh scan with a live token succeeds (201)", scan.status === 201, `${scan.status} ${JSON.stringify(scan.data)}`);

  const broadcast = await lecturerSocket.next((m) => m.type === "attendance", 5000).catch(() => null);
  check("lecturer socket receives the attendance broadcast", broadcast?.studentName === `E2E student`, JSON.stringify(broadcast));

  const roster = await api(`/api/sessions/${sessionId}/attendance`, { as: "lecturer" });
  check("roster now contains the scan", roster.status === 200 && roster.data.length === 1, JSON.stringify(roster.data));

  const dupScan = await api("/api/attend", { method: "POST", as: "student", ip: "10.0.0.1", body: { sessionId, token: liveToken } });
  check("repeat scan returns 409 already_scanned", dupScan.status === 409 && dupScan.data?.error === "already_scanned", `${dupScan.status} ${JSON.stringify(dupScan.data)}`);

  const garbage = await api("/api/attend", { method: "POST", as: "student", ip: "10.0.0.2", body: { sessionId, token: "garbage" } });
  check("garbage token returns 422 mismatched", garbage.status === 422 && garbage.data?.reason === "mismatched token", JSON.stringify(garbage.data));

  const staleToken = await freshToken(projector);
  await new Promise((r) => setTimeout(r, 11000)); // outlive the 10s TTL
  const expired = await api("/api/attend", { method: "POST", as: "student", ip: "10.0.0.3", body: { sessionId, token: staleToken } });
  check("token used >10s later returns 422 expired", expired.status === 422 && expired.data?.reason === "expired", JSON.stringify(expired.data));

  const lecturerScan = await api("/api/attend", { method: "POST", as: "lecturer", ip: "10.0.0.4", body: { sessionId, token: "x" } });
  check("lecturer scanning returns 403", lecturerScan.status === 403, `got ${lecturerScan.status}`);

  const anonScan = await api("/api/attend", { method: "POST", ip: "10.0.0.5", body: { sessionId, token: "x" } });
  check("unauthenticated scan returns 401", anonScan.status === 401, `got ${anonScan.status}`);

  const missingFields = await api("/api/attend", { method: "POST", as: "student", ip: "10.0.0.6", body: { sessionId } });
  check("scan without a token returns 400", missingFields.status === 400, `got ${missingFields.status}`);

  const ghostSession = await api("/api/attend", { method: "POST", as: "student", ip: "10.0.0.7", body: { sessionId: "nope", token: "x" } });
  check("scan against unknown session returns 404", ghostSession.status === 404, `got ${ghostSession.status}`);

  // ----------------------------------------------------------- concurrency
  section("Concurrency");
  const crowd = [];
  for (let i = 0; i < 6; i++) {
    const label = `crowd${i}`;
    const u = await signup(label, "student");
    await login(label, u.email);
    crowd.push({ label, name: `E2E ${label}` });
  }

  // NOTE: assertions here are invariants ("rows == successes", "broadcasts ==
  // successes"), not exact counts. The dev server's per-request latency swings
  // from ~0.5s to ~16s, so with a 10s token TTL some scans in a batch can
  // legitimately expire mid-flight. What must ALWAYS hold is that a success
  // creates exactly one row and exactly one broadcast.
  let rosterBefore, beforeCount, results, created, statuses;
  // Retry: on a slow dev server every scan in a batch can expire before the
  // server even processes it, leaving nothing to assert against.
  for (let attempt = 1; attempt <= 3; attempt++) {
    rosterBefore = (await api(`/api/sessions/${sessionId}/attendance`, { as: "lecturer" })).data.length;
    beforeCount = lecturerSocket.messages.filter((m) => m.type === "attendance").length;
    const concurrentToken = await freshToken(projector);

    results = await Promise.all(
      crowd.map((c, i) =>
        api("/api/attend", { method: "POST", as: c.label, ip: `10.1.0.${i + 1}`, body: { sessionId, token: concurrentToken } }),
      ),
    );
    created = results.filter((r) => r.status === 201).length;
    statuses = results.map((r) => r.status);
    if (created > 0) break;
    console.log(`  ..  attempt ${attempt}: all scans expired before the server processed them, retrying`);
  }
  check("concurrent scans from different students are accepted", created >= 1, `statuses: ${JSON.stringify(statuses)}`);
  // A 5xx here is worth chasing. Note that `wrangler dev`'s local ProxyWorker
  // can itself drop connections under burst load and surface them as 500s with
  // no worker-side error — check the server log before assuming it's the app.
  check("no concurrent scan produced a 5xx", !statuses.some((s) => s >= 500), JSON.stringify(statuses));

  const broadcasts = await lecturerSocket.untilCount((m) => m.type === "attendance", beforeCount + created, 12000);
  check("every successful scan produced exactly one broadcast (none dropped)",
    broadcasts.length - beforeCount === created, `${broadcasts.length - beforeCount} broadcasts for ${created} successes`);

  const rosterAfter = await api(`/api/sessions/${sessionId}/attendance`, { as: "lecturer" });
  check("roster grew by exactly the number of successes (no duplicates)",
    rosterAfter.data.length === rosterBefore + created, `${rosterBefore} -> ${rosterAfter.data?.length}, ${created} successes`);

  // same student, same token, fired simultaneously -> at most one row wins
  const racer = await signup("racer", "student");
  await login("racer", racer.email);
  const raceToken = await freshToken(projector);
  const raceResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      api("/api/attend", { method: "POST", as: "racer", ip: "10.2.0.1", body: { sessionId, token: raceToken } }),
    ),
  );
  const raceStatuses = raceResults.map((r) => r.status);
  const raceCreated = raceResults.filter((r) => r.status === 201).length;
  check("5 simultaneous scans by the SAME student create at most 1 row", raceCreated <= 1, JSON.stringify(raceStatuses));
  check("the losing racers are rejected cleanly, never 5xx", !raceStatuses.some((s) => s >= 500), JSON.stringify(raceStatuses));

  const racerRows = (await api(`/api/sessions/${sessionId}/attendance`, { as: "lecturer" })).data.filter((r) => r.name === "E2E racer");
  check("the racing student appears at most once in the roster", racerRows.length <= 1, `got ${racerRows.length}`);

  // ------------------------------------------------------------ anti-fraud
  section("Anti-fraud (Phase 7)");
  const geoSession = await api("/api/sessions", {
    method: "POST",
    as: "lecturer",
    body: { courseId, roomLat: 40.7128, roomLng: -74.006 },
  });
  const geoSessionId = geoSession.data?.id;
  const geoProjector = await openSocket(geoSessionId, "projector");
  const geoToken = await freshToken(geoProjector);

  const farAway = await api("/api/attend", {
    method: "POST",
    as: "student",
    ip: "10.3.0.1",
    body: { sessionId: geoSessionId, token: geoToken, lat: 51.5074, lng: -0.1278 },
  });
  check("scan from far outside the radius returns 422 outside_geofence", farAway.status === 422 && farAway.data?.error === "outside_geofence", JSON.stringify(farAway.data));

  const noCoords = await api("/api/attend", {
    method: "POST",
    as: "student",
    ip: "10.3.0.2",
    body: { sessionId: geoSessionId, token: geoToken },
  });
  check("geofenced session rejects a scan with no coordinates", noCoords.status === 422 && noCoords.data?.error === "outside_geofence", JSON.stringify(noCoords.data));

  const nearToken = await freshToken(geoProjector);
  const nearby = await api("/api/attend", {
    method: "POST",
    as: "student",
    ip: "10.3.0.3",
    body: { sessionId: geoSessionId, token: nearToken, lat: 40.71285, lng: -74.00602 },
  });
  check("scan from inside the radius succeeds", nearby.status === 201, `${nearby.status} ${JSON.stringify(nearby.data)}`);

  // Rate limit: 10/min per IP. Sequential, so ordering is deterministic and
  // "the first 10 pass, later ones are limited" is actually meaningful —
  // concurrently the counter's ordering is unobservable.
  const hammerIp = `10.4.0.${Math.floor(Math.random() * 200) + 1}`;
  const hammer = [];
  for (let i = 0; i < 14; i++) {
    hammer.push(await api("/api/attend", { method: "POST", as: "student", ip: hammerIp, body: { sessionId, token: "x" } }));
  }
  const statusesOf = hammer.map((r) => r.status);
  check("the first 10 requests from an IP are not rate limited",
    statusesOf.slice(0, 10).every((s) => s !== 429), JSON.stringify(statusesOf));
  check("requests past the 10/min limit are rejected with 429",
    statusesOf.slice(10).some((s) => s === 429), JSON.stringify(statusesOf));

  const otherIp = await api("/api/attend", { method: "POST", as: "student", ip: "10.4.0.99", body: { sessionId, token: "x" } });
  check("a different IP is unaffected by that rate limit", otherIp.status !== 429, `got ${otherIp.status}`);

  // -------------------------------------------------------- session ending
  section("Ending a session");
  const foreignEnd = await api(`/api/sessions/${sessionId}/end`, { method: "POST", as: "lecturer2" });
  check("non-owning lecturer cannot end the session", foreignEnd.status === 403, `got ${foreignEnd.status}`);

  const end = await api(`/api/sessions/${sessionId}/end`, { method: "POST", as: "lecturer" });
  check("owning lecturer can end the session", end.status === 200, `got ${end.status}`);

  const endAgain = await api(`/api/sessions/${sessionId}/end`, { method: "POST", as: "lecturer" });
  check("ending twice returns 409", endAgain.status === 409, `got ${endAgain.status}`);

  const postEndToken = await freshToken(projector).catch(() => "no-token");
  const scanEnded = await api("/api/attend", { method: "POST", as: "racer", ip: "10.5.0.1", body: { sessionId, token: postEndToken } });
  check("scanning an ended session returns 410", scanEnded.status === 410, `${scanEnded.status} ${JSON.stringify(scanEnded.data)}`);

  const endedDetail = await api(`/api/sessions/${sessionId}`, { as: "lecturer" });
  check("ended session reports endedAt", endedDetail.data?.endedAt !== null && endedDetail.data?.endedAt !== undefined);

  projector.close();
  lecturerSocket.close();
  geoProjector.close();

  // ----------------------------------------------------------------- pages
  section("Pages render");
  for (const [path, needle] of [
    ["/", "<!DOCTYPE html>"],
    ["/login", "Log in"],
    ["/attend", "<!DOCTYPE html>"],
  ]) {
    const res = await fetch(`${BASE}${path}`);
    const html = await res.text();
    check(`GET ${path} renders`, res.status === 200 && html.includes(needle), `status ${res.status}`);
  }

  const dashboardAnon = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
  check("/dashboard redirects an anonymous visitor to /login", dashboardAnon.status === 307 || dashboardAnon.status === 302, `got ${dashboardAnon.status}`);

  const dashboardStudent = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: `session=${cookies.get("student")}` },
    redirect: "manual",
  });
  check("/dashboard returns 403 for a student", dashboardStudent.status === 403, `got ${dashboardStudent.status}`);

  const dashboardLecturer = await fetch(`${BASE}/dashboard`, { headers: { Cookie: `session=${cookies.get("lecturer")}` } });
  check("/dashboard renders for a lecturer", dashboardLecturer.status === 200, `got ${dashboardLecturer.status}`);

  // --------------------------------------------------------------- summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`${"=".repeat(50)}`);
  console.log(`\nTEST_EMAIL_SUFFIX=${uniq}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(2);
});
