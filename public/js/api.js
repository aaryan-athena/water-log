// Thin client for the detection API.

async function parse(response) {
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : null;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return body;
}

export async function detect(blob, { overlay = true, signal } = {}) {
  const form = new FormData();
  form.append("file", blob, "frame.jpg");
  form.append("include_overlay", overlay ? "true" : "false");
  return parse(await fetch("/api/detect", { method: "POST", body: form, signal }));
}

export async function health() {
  return parse(await fetch("/api/health"));
}

export async function meta() {
  return parse(await fetch("/api/meta"));
}
