const baseUrl = String(process.env.WORKER_BASE_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
const secret = String(process.env.WORKER_ADMIN_TEST_SECRET || process.env.WORKER_ADMIN_SECRET || process.env.ADMIN_SECRET || "").trim();

const url = new URL(`${baseUrl}/worker/review/process-submission`);
if (secret) url.searchParams.set("secret", secret);

const response = await fetch(url, { method: "POST" });
const text = await response.text();

let body = text;
try {
  body = JSON.parse(text);
} catch {
  // keep raw text
}

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  body
}, null, 2));

if (!response.ok) process.exit(1);