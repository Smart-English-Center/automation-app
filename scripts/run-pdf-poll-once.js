const baseUrl = String(
  process.env.WORKER_BASE_URL ||
  process.env.PUBLIC_WORKER_BASE_URL ||
  process.env.SLIPLANE_APP_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`
).replace(/\/+$/, "");

const secret = String(
  process.env.WORKER_ADMIN_TEST_SECRET ||
  process.env.WORKER_ADMIN_SECRET ||
  process.env.ADMIN_SECRET ||
  ""
).trim();

const url = new URL(`${baseUrl}/worker/pdf/poll`);
if (secret) url.searchParams.set("secret", secret);
if (process.env.PDFMONKEY_POLL_LIMIT) {
  url.searchParams.set("limit", process.env.PDFMONKEY_POLL_LIMIT);
}

try {
  const response = await fetch(url, { method: "POST" });
  const text = await response.text();

  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw body
  }

  const result = {
    ok: response.ok,
    script: "run-pdf-poll-once",
    status: response.status,
    url: url.toString(),
    response: body,
    at: new Date().toISOString()
  };

  console.log(JSON.stringify(result, null, 2));

  if (!response.ok || body?.ok === false) {
    process.exit(1);
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    script: "run-pdf-poll-once",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }, null, 2));

  process.exit(1);
}
