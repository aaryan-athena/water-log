// Shared helpers: severity vocabulary, DOM, images, toasts.

export const BANDS = [
  { label: "none", max: 2, colour: "#2f9e6b" },
  { label: "minor", max: 8, colour: "#d4a72c" },
  { label: "moderate", max: 20, colour: "#e07b39" },
  { label: "severe", max: 40, colour: "#d64545" },
  { label: "critical", max: 100, colour: "#9b2c5a" },
];

const PLAIN = {
  none: "No standing water found in this view.",
  minor: "A small amount of standing water — puddles, probably passable.",
  moderate: "A noticeable stretch of standing water. Worth a closer look.",
  severe: "A large part of the view is under water. Likely impassable in places.",
  critical: "Most of the view is under water. Treat as blocked until checked.",
};

export const $ = (id) => document.getElementById(id);
export const plainFor = (label) => PLAIN[label] || "";
export const colourFor = (label) => (BANDS.find((b) => b.label === label) || BANDS[0]).colour;
export const rankOf = (label) => Math.max(0, BANDS.findIndex((b) => b.label === label));

export function bandFor(pct) {
  return BANDS.find((b) => pct <= b.max) || BANDS[BANDS.length - 1];
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fmtPct(n) {
  const v = Number(n) || 0;
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function sevPill(node, label) {
  node.textContent = label;
  node.style.setProperty("--c", colourFor(label));
}

/** Five-band scale with a marker positioned by band, not linearly. */
export function renderScale(container, pct) {
  const band = bandFor(pct);
  const idx = BANDS.indexOf(band);
  const lower = idx === 0 ? 0 : BANDS[idx - 1].max;
  const within = Math.min(1, Math.max(0, (pct - lower) / (band.max - lower || 1)));
  const left = ((idx + within) / BANDS.length) * 100;

  if (!container.firstChild) {
    container.append(
      el("div", { class: "scale-marker" }),
      el("div", { class: "scale-bands" },
        BANDS.map((b) => el("span", { class: "scale-band", style: `--c:${b.colour}` }))),
      el("div", { class: "scale-labels" }, BANDS.map((b) => el("span", {}, b.label))),
    );
  }
  container.querySelector(".scale-marker").style.left = `${left}%`;
  container.querySelectorAll(".scale-band").forEach((node, i) => node.classList.toggle("is-on", i <= idx));
}

export function statTile(label, value) {
  return el("div", { class: "stat" },
    el("div", { class: "stat-label" }, label),
    el("div", { class: "stat-value" }, value));
}

export function toast(message, isError = false) {
  const node = el("div", { class: `toast${isError ? " is-error" : ""}`, role: "status" }, message);
  $("toasts").append(node);
  setTimeout(() => node.remove(), isError ? 6000 : 3200);
}

// -- images ----------------------------------------------------------------
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = src;
  });
}

/** Draw any image source onto a new canvas, longest side capped at maxSide. */
export function toCanvas(source, maxSide, srcW, srcH) {
  const w = srcW || source.naturalWidth || source.videoWidth || source.width;
  const h = srcH || source.naturalHeight || source.videoHeight || source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.88) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), type, quality));
}

/** Decode a photo honouring its EXIF orientation. */
export async function fileToCanvas(file, maxSide) {
  if ("createImageBitmap" in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const canvas = toCanvas(bmp, maxSide, bmp.width, bmp.height);
      bmp.close?.();
      return canvas;
    } catch { /* fall through to <img> decoding */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return toCanvas(await loadImage(url), maxSide);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Photo + overlay PNG composited into one canvas. */
export async function composite(baseCanvas, overlayUrl, maxSide = 1600) {
  const out = toCanvas(baseCanvas, maxSide);
  if (overlayUrl) {
    const overlay = await loadImage(overlayUrl);
    out.getContext("2d").drawImage(overlay, 0, 0, out.width, out.height);
  }
  return out;
}
