// Full browser end-to-end: lecturer runs a projector, a student "scans" the
// QR by actually DECODING the rendered QR image and navigating to that URL.
// Mirrors Phase 8 step 1 of the plan.

import { chromium } from "playwright";
import jsQR from "jsqr";
import { PNG } from "pngjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const uniq = Date.now().toString(36);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

function decodeQr(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result?.data ?? null;
}

async function signup(name, role) {
  const email = `bx-${name}-${uniq}@example.com`;
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `BX ${name}`, email, password: "testpass123", role }),
  });
  if (res.status !== 201) throw new Error(`signup ${name}: ${res.status}`);
  return email;
}

async function loginUi(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "testpass123");
  await page.click('button[type="submit"]');
}

const browser = await chromium.launch();
const errors = [];

// ---------------------------------------------------------------- lecturer
const lecturerEmail = await signup("lecturer", "lecturer");
const studentEmail = await signup("student", "student");

const lecturerCtx = await browser.newContext();
const lecturer = await lecturerCtx.newPage();
lecturer.on("pageerror", (e) => errors.push(`lecturer: ${e}`));
lecturer.on("console", (m) => { if (m.type() === "error") errors.push(`lecturer console: ${m.text()}`); });

console.log("\n=== Lecturer flow (browser) ===");
await loginUi(lecturer, lecturerEmail);
await lecturer.waitForURL("**/dashboard", { timeout: 20000 });
check("lecturer lands on /dashboard after login", lecturer.url().endsWith("/dashboard"));

// create a course through the UI
await lecturer.fill('input >> nth=0', `Browser E2E ${uniq}`);
await lecturer.fill('input >> nth=1', `BX${uniq}`);
await lecturer.click('button:has-text("Add course")');
await lecturer.waitForFunction(
  () => document.querySelectorAll("select option").length > 0 &&
        !document.querySelector("select option").textContent.includes("No courses yet"),
  { timeout: 15000 },
);
check("course created via the dashboard UI appears in the picker", true);

await lecturer.click('button:has-text("Start session")');
await lecturer.waitForURL("**/projector", { timeout: 20000 });
const sessionId = /sessions\/([^/]+)\/projector/.exec(lecturer.url())[1];
check("starting a session redirects to the projector page", Boolean(sessionId));

await lecturer.waitForSelector('img[alt="Scan to check in"]', { timeout: 20000 });
const qrSrc = await lecturer.getAttribute('img[alt="Scan to check in"]', "src");
check("projector renders a QR image", Boolean(qrSrc?.startsWith("data:image/png")));

// ------------------------------------------------------- decode the real QR
console.log("\n=== Student scans the actual QR ===");
const scanUrl = decodeQr(qrSrc);
check("QR image decodes to a URL", Boolean(scanUrl), String(scanUrl));
check("decoded URL points at /attend with session + token",
  scanUrl?.includes("/attend?session=") && scanUrl?.includes("&token="), String(scanUrl));
check("decoded URL carries this session's id", scanUrl?.includes(sessionId), String(scanUrl));

const studentCtx = await browser.newContext();
const student = await studentCtx.newPage();
student.on("pageerror", (e) => errors.push(`student: ${e}`));

await loginUi(student, studentEmail);
await student.waitForURL(`${BASE}/`, { timeout: 20000 }).catch(() => {});
check("student login redirects away from /dashboard (role-aware)", !student.url().includes("/dashboard"), student.url());

// re-read the QR right before scanning so the token is fresh
const freshQr = await lecturer.getAttribute('img[alt="Scan to check in"]', "src");
const freshUrl = decodeQr(freshQr).replace(/^https?:\/\/[^/]+/, BASE);

await student.goto(freshUrl);
await student.waitForFunction(() => !document.body.textContent.includes("Checking in"), { timeout: 20000 });
const studentText = await student.textContent("body");
check("student sees 'You're checked in' after scanning the real QR",
  studentText.includes("You're checked in"), studentText.slice(0, 120));

// ------------------------------------------- projector updates live, no reload
console.log("\n=== Live update on the projector ===");
const appeared = await lecturer
  .waitForFunction(() => document.body.textContent.includes("BX student"), { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("student's name appears on the projector live (no reload)", appeared);

const counterText = await lecturer.textContent("h2");
check("attendance counter shows 1", counterText.includes("(1)"), counterText);

// ------------------------------------------------------------ second scan
console.log("\n=== Re-scan / end session ===");
const secondQr = decodeQr(await lecturer.getAttribute('img[alt="Scan to check in"]', "src")).replace(/^https?:\/\/[^/]+/, BASE);
await student.goto(secondQr);
await student.waitForFunction(() => !document.body.textContent.includes("Checking in"), { timeout: 20000 });
const secondText = await student.textContent("body");
check("scanning again shows 'Already recorded'", secondText.includes("Already recorded"), secondText.slice(0, 120));

await lecturer.click('button:has-text("End session")');
await lecturer.waitForFunction(() => document.body.textContent.includes("Session ended"), { timeout: 15000 });
check("projector shows 'Session ended' after ending", true);

await student.goto(secondQr);
await student.waitForFunction(() => !document.body.textContent.includes("Checking in"), { timeout: 20000 });
const endedText = await student.textContent("body");
check("scanning an ended session shows 'This session has ended'",
  endedText.includes("This session has ended"), endedText.slice(0, 120));

check("no uncaught page errors in either context", errors.length === 0, JSON.stringify(errors.slice(0, 3)));

await browser.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`PASSED: ${passed}   FAILED: ${failed}`);
if (failures.length) { console.log("\nFailures:"); for (const f of failures) console.log(`  - ${f}`); }
console.log(`${"=".repeat(50)}`);
process.exit(failed === 0 ? 0 : 1);
