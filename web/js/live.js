// Live camera: grab a frame, send it, draw the returned mask, repeat.
//
// Plain HTTP rather than a WebSocket so it works on serverless hosting. Only
// one frame is ever in flight: if the server is slower than the camera,
// frames are skipped instead of queued, so the overlay never lags behind.

import * as api from "./api.js";
import * as store from "./store.js";
import { $, plainFor, fmtPct, sevPill, renderScale, statTile, toast,
         toCanvas, canvasToBlob, composite, loadImage } from "./util.js";

const FRAME_MAX_SIDE = 640;
const MIN_INTERVAL_MS = 350;       // cap at ~3 requests/second
const SAVE_INTERVAL_MS = 20000;    // at most one saved alert per 20 s

let stream = null;
let running = false;
let lastSaved = 0;
let stats = { frames: 0, peak: 0, alerts: 0, ms: 0 };

function renderStats() {
  $("l-stats").replaceChildren(
    statTile("Frames", stats.frames),
    statTile("Peak", `${fmtPct(stats.peak)}%`),
    statTile("Alerts", stats.alerts),
    statTile("Latency", stats.ms ? `${Math.round(stats.ms)} ms` : "—"),
  );
}

function renderReading(pct, label) {
  $("l-pct").textContent = fmtPct(pct);
  sevPill($("l-pill"), label);
  $("l-text").textContent = plainFor(label);
  renderScale($("l-scale"), pct);
}

async function drawOverlay(url) {
  const video = $("live-video");
  const canvas = $("live-overlay");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (url) ctx.drawImage(await loadImage(url), 0, 0, canvas.width, canvas.height);
}

async function loop() {
  const video = $("live-video");
  while (running) {
    const started = performance.now();
    if (video.videoWidth) {
      try {
        const frame = toCanvas(video, FRAME_MAX_SIDE);
        const res = await api.detect(await canvasToBlob(frame, "image/jpeg", 0.75));
        if (!running) break;
        const sev = res.severity;
        stats.frames += 1;
        stats.ms = performance.now() - started;
        stats.peak = Math.max(stats.peak, sev.coverage_pct);
        if (res.alert) stats.alerts += 1;
        renderReading(sev.coverage_pct, sev.severity);
        renderStats();
        await drawOverlay(res.overlay_png);

        if (res.alert && $("live-save").checked && Date.now() - lastSaved > SAVE_INTERVAL_MS) {
          lastSaved = Date.now();
          const shown = await composite(frame, res.overlay_png);
          await store.add({
            source: "live",
            label: $("live-name").value.trim() || "Live camera",
            coverage_pct: sev.coverage_pct, severity: sev.severity, alert: true,
            regions: sev.water_regions,
            thumb: await canvasToBlob(toCanvas(shown, 480), "image/jpeg", 0.8),
            image: await canvasToBlob(shown, "image/jpeg", 0.85),
          });
          toast("Alert saved to history.");
        }
      } catch (err) {
        if (!running) break;
        toast(err.message || "Live detection failed.", true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const wait = MIN_INTERVAL_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const select = $("camera-select");
  const current = select.value;
  select.replaceChildren(new Option("Default camera", ""));
  devices.forEach((d, i) => select.append(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  select.value = current;
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Camera access needs HTTPS (or localhost) and a supported browser.", true);
    return;
  }
  const deviceId = $("camera-select").value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    toast(err.name === "NotAllowedError" ? "Camera permission was denied." : `Could not start the camera: ${err.message}`, true);
    return;
  }
  const video = $("live-video");
  video.srcObject = stream;
  await video.play();
  await listCameras();

  stats = { frames: 0, peak: 0, alerts: 0, ms: 0 };
  renderStats();
  running = true;
  $("live-idle").hidden = true;
  $("live-badge").hidden = false;
  $("live-toggle").textContent = "Stop camera";
  $("live-toggle").className = "btn btn-ghost btn-block";
  loop();
}

export function stop() {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const video = $("live-video");
  video.srcObject = null;
  const canvas = $("live-overlay");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  $("live-idle").hidden = false;
  $("live-badge").hidden = true;
  $("live-toggle").textContent = "Start camera";
  $("live-toggle").className = "btn btn-primary btn-block";
  renderReading(0, "none");
  $("l-text").textContent = "Start the camera to begin.";
}

export function init() {
  renderReading(0, "none");
  $("l-text").textContent = "Start the camera to begin.";
  renderStats();
  $("live-toggle").addEventListener("click", () => (running ? stop() : start()));
  listCameras().catch(() => {});
  window.addEventListener("pagehide", stop);
}

export const isRunning = () => running;
