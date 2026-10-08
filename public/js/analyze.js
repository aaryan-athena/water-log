// Analyze view: one photo, or a video sampled frame by frame in the browser.
//
// Videos are never uploaded whole. The browser seeks through the file, grabs
// a frame at each step and sends it as a small JPEG, which keeps every
// request far below serverless body-size and time limits.

import * as api from "./api.js";
import * as store from "./store.js";
import {
  $, el, BANDS, bandFor, colourFor, plainFor, fmtPct, fmtTime, fmtBytes, sevPill,
  renderScale, statTile, toast, toCanvas, canvasToBlob, fileToCanvas, composite, loadImage,
} from "./util.js";

const PHOTO_MAX_SIDE = 1600;
const FRAME_MAX_SIDE = 960;
const MAX_FRAMES = 120;
const THUMB_SIDE = 480;

let file = null;
let busy = false;
let controller = null;
let videoFrames = []; // [{t, result, jpeg: Blob}]

const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(f.name);

// -- file selection --------------------------------------------------------
function choose(f) {
  file = f || null;
  $("dz-empty").hidden = !!file;
  $("dz-file").hidden = !file;
  $("analyze-btn").disabled = !file || busy;
  $("video-options").hidden = !file || !isVideo(file);
  if (!file) { $("file-input").value = ""; return; }

  $("dz-name").textContent = file.name;
  $("dz-size").textContent = `${isVideo(file) ? "Video" : "Photo"} · ${fmtBytes(file.size)}`;
  const thumb = $("dz-thumb");
  thumb.textContent = "";
  thumb.style.backgroundImage = "";
  if (isVideo(file)) {
    thumb.textContent = "VIDEO";
    posterFor(file).then((url) => {
      if (url && file && isVideo(file)) { thumb.textContent = ""; thumb.style.backgroundImage = `url("${url}")`; }
    });
  } else {
    const url = URL.createObjectURL(file);
    thumb.style.backgroundImage = `url("${url}")`;
  }
}

/** First frame of a video as a small data URL, for the file chip. */
async function posterFor(f) {
  const url = URL.createObjectURL(f);
  const video = el("video", { muted: true, playsinline: true, preload: "auto" });
  video.src = url;
  try {
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
    await seek(video, Math.min(0.5, (video.duration || 1) / 2));
    return toCanvas(video, 160).toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// -- rendering -------------------------------------------------------------
function showResultShell() {
  $("result-empty").hidden = true;
  $("result").hidden = false;
}

function drawStage(canvas) {
  const stage = $("stage-canvas");
  stage.width = canvas.width;
  stage.height = canvas.height;
  stage.getContext("2d").drawImage(canvas, 0, 0);
}

function renderVerdict(pct, label, subtitle) {
  $("v-pct").textContent = fmtPct(pct);
  sevPill($("v-pill"), label);
  $("v-sub").textContent = subtitle;
  $("v-text").textContent = plainFor(label);
  renderScale($("v-scale"), pct);
  const pill = $("stage-pill");
  pill.textContent = label;
  pill.style.background = colourFor(label);
}

function renderAlert(isAlert, text) {
  $("v-alert").hidden = !isAlert;
  if (isAlert) $("v-alert-text").textContent = text;
}

function renderStats(tiles) {
  const box = $("v-stats");
  box.replaceChildren(...tiles.map(([label, value]) => statTile(label, value)));
}

// -- photo -----------------------------------------------------------------
async function analyzePhoto() {
  setProgress("Analyzing photo…", null);
  const canvas = await fileToCanvas(file, PHOTO_MAX_SIDE);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
  const res = await api.detect(blob, { signal: controller.signal });

  const shown = await composite(canvas, res.overlay_png);
  showResultShell();
  $("video-panel").hidden = true;
  drawStage(shown);

  const sev = res.severity;
  renderVerdict(sev.coverage_pct, sev.severity, "of the view is covered by standing water");
  renderAlert(res.alert, `${fmtPct(sev.coverage_pct)}% coverage is above the alert threshold.`);
  renderStats([
    ["Water regions", sev.water_regions],
    ["Image size", `${res.frame.width}×${res.frame.height}`],
    ["Processed in", `${Math.round(res.inference_ms)} ms`],
  ]);

  if ($("save-history").checked) {
    await save("image", sev, res.alert, shown, null);
  }
}

// -- video -----------------------------------------------------------------
function seek(video, t) {
  return new Promise((resolve, reject) => {
    const done = () => { video.removeEventListener("seeked", done); resolve(); };
    video.addEventListener("seeked", done);
    video.onerror = () => reject(new Error("This video could not be decoded by the browser."));
    video.currentTime = t;
  });
}

async function analyzeVideo() {
  const url = URL.createObjectURL(file);
  const video = el("video", { muted: true, playsinline: true, preload: "auto" });
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error(
        "This browser can't decode that video. Try an MP4 (H.264) file."));
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) throw new Error("Could not read the video's length.");

    let step = Number($("frame-step").value) || 1;
    if (duration / step > MAX_FRAMES) step = duration / MAX_FRAMES;
    const times = [];
    for (let t = 0; t < duration; t += step) times.push(Math.min(t, duration - 0.05));

    videoFrames = [];
    showResultShell();
    $("video-panel").hidden = false;
    $("timeline").replaceChildren();
    $("events").replaceChildren();
    $("tl-end").textContent = fmtTime(duration);
    renderAlert(false);

    for (let i = 0; i < times.length; i++) {
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      setProgress(`Analyzing frame ${i + 1} of ${times.length}`, (i / times.length) * 100);
      await seek(video, times[i]);
      const frame = toCanvas(video, FRAME_MAX_SIDE);
      const jpeg = await canvasToBlob(frame, "image/jpeg", 0.85);
      const res = await api.detect(jpeg, { signal: controller.signal });
      videoFrames.push({ t: times[i], result: res, jpeg });
      appendBar(videoFrames.length - 1);
      if (i === 0 || res.severity.coverage_pct >= peak().result.severity.coverage_pct) {
        await showFrame(videoFrames.length - 1);
      }
    }
    setProgress("Done", 100);
    summariseVideo(duration);

    if ($("save-history").checked) {
      const worst = peak();
      const shown = await frameComposite(worst);
      await save("video", worst.result.severity, videoFrames.some((f) => f.result.alert),
        shown, { video_time: worst.t, frames: videoFrames.length });
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

const peak = () => videoFrames.reduce((a, b) =>
  (b.result.severity.coverage_pct > a.result.severity.coverage_pct ? b : a), videoFrames[0]);

async function frameComposite(frame) {
  const url = URL.createObjectURL(frame.jpeg);
  try {
    const img = await loadImage(url);
    return composite(toCanvas(img, FRAME_MAX_SIDE), frame.result.overlay_png);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function showFrame(index) {
  const frame = videoFrames[index];
  drawStage(await frameComposite(frame));
  const sev = frame.result.severity;
  renderVerdict(sev.coverage_pct, sev.severity, `at ${fmtTime(frame.t)} in the video`);
  $("timeline").querySelectorAll(".tl-bar").forEach((b, i) => b.classList.toggle("is-current", i === index));
}

function appendBar(index) {
  const { t, result } = videoFrames[index];
  const pct = result.severity.coverage_pct;
  const band = bandFor(pct);
  const rank = BANDS.indexOf(band);
  const within = Math.min(1, pct / band.max);
  const height = pct < 0.5 ? 6 : 14 + (rank + within) * 17;
  const bar = el("button", {
    class: `tl-bar${pct < 0.5 ? " is-dry" : ""}`,
    style: `height:${Math.min(100, height)}%;--c:${band.colour}`,
    title: `${fmtTime(t)} — ${fmtPct(pct)}% (${band.label})`,
    "aria-label": `${fmtTime(t)}, ${fmtPct(pct)} percent`,
    onclick: () => showFrame(index),
  });
  $("timeline").append(bar);
}

function summariseVideo(duration) {
  const wet = videoFrames.filter((f) => f.result.severity.coverage_pct > 2);
  const worst = peak();
  const alerts = videoFrames.filter((f) => f.result.alert).length;
  renderAlert(alerts > 0, `${alerts} sampled moment${alerts === 1 ? "" : "s"} crossed the alert threshold.`);
  renderStats([
    ["Peak coverage", `${fmtPct(worst.result.severity.coverage_pct)}%`],
    ["Frames with water", `${wet.length} / ${videoFrames.length}`],
    ["Video length", fmtTime(duration)],
  ]);
  showFrame(videoFrames.indexOf(worst));

  // Group consecutive wet samples into events an operator can jump to.
  const events = [];
  videoFrames.forEach((f, i) => {
    if (f.result.severity.coverage_pct <= 2) return;
    const last = events[events.length - 1];
    if (last && last.endIndex === i - 1) {
      last.endIndex = i; last.end = f.t;
      if (f.result.severity.coverage_pct > last.peak) { last.peak = f.result.severity.coverage_pct; last.peakIndex = i; }
    } else {
      events.push({ start: f.t, end: f.t, endIndex: i, peak: f.result.severity.coverage_pct, peakIndex: i });
    }
  });
  const list = $("events");
  if (!events.length) {
    list.append(el("li", { class: "ev-none" }, "No standing water in any sampled frame."));
    return;
  }
  for (const ev of events) {
    const label = bandFor(ev.peak).label;
    const pill = el("span", { class: "sev-pill" });
    sevPill(pill, label);
    list.append(el("li", { onclick: () => showFrame(ev.peakIndex) },
      el("span", { class: "ev-time" }, `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`),
      pill,
      el("span", { class: "ev-peak" }, `peak ${fmtPct(ev.peak)}%`)));
  }
}

// -- shared ----------------------------------------------------------------
async function save(source, sev, alert, canvas, extra) {
  const thumb = await canvasToBlob(toCanvas(canvas, THUMB_SIDE), "image/jpeg", 0.8);
  const image = await canvasToBlob(toCanvas(canvas, 1280), "image/jpeg", 0.85);
  await store.add({
    source,
    label: $("source-name").value.trim() || file.name,
    coverage_pct: sev.coverage_pct,
    severity: sev.severity,
    alert: !!alert,
    regions: sev.water_regions,
    thumb, image, ...extra,
  });
}

function setProgress(text, pct) {
  const box = $("progress");
  box.hidden = false;
  $("progress-text").textContent = text;
  box.classList.toggle("is-indeterminate", pct == null);
  $("progress-fill").style.width = pct == null ? "" : `${pct}%`;
}

async function run() {
  if (!file || busy) return;
  busy = true;
  controller = new AbortController();
  const btn = $("analyze-btn");
  btn.disabled = true;
  btn.replaceChildren(el("span", { class: "spinner" }), el("span", {}, "Analyzing"));
  $("cancel-btn").hidden = !isVideo(file);
  try {
    if (isVideo(file)) await analyzeVideo();
    else await analyzePhoto();
    setProgress("Done", 100);
  } catch (err) {
    if (err.name === "AbortError") {
      toast("Analysis cancelled.");
      if (videoFrames.length) summariseVideo(videoFrames[videoFrames.length - 1].t);
    } else {
      toast(err.message || "Something went wrong.", true);
    }
  } finally {
    busy = false;
    btn.replaceChildren(el("span", { class: "btn-label" }, "Analyze"));
    btn.disabled = !file;
    $("cancel-btn").hidden = true;
    setTimeout(() => { if (!busy) $("progress").hidden = true; }, 600);
  }
}

export function init() {
  const dz = $("dropzone");
  const input = $("file-input");
  input.addEventListener("change", () => input.files[0] && choose(input.files[0]));
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => {
    e.preventDefault(); dz.classList.add("is-drag");
  }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => {
    e.preventDefault(); dz.classList.remove("is-drag");
  }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) choose(f);
  });
  $("dz-clear").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); choose(null); });
  $("analyze-btn").addEventListener("click", run);
  $("cancel-btn").addEventListener("click", () => controller?.abort());
}
