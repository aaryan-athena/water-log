// History: checks saved on this device, with filters and a detail view.

import * as store from "./store.js";
import { $, el, fmtPct, fmtTime, fmtWhen, rankOf, sevPill, renderScale, statTile, toast } from "./util.js";

const ICONS = {
  image: "M4 16l4.5-4.5a2 2 0 0 1 2.8 0L16 16m-2-2 1.5-1.5a2 2 0 0 1 2.8 0L20 14M6 20h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z",
  video: "M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z",
  live: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 12h2m16 0h2M12 2v2m0 16v2",
};
const SOURCE_NAMES = { image: "Photo", video: "Video", live: "Live camera" };

let rows = [];
let minSeverity = "";
const urls = new Set();

function icon(source) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[source] || ICONS.image);
  svg.append(path);
  return svg;
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}

function filtered() {
  const q = $("f-search").value.trim().toLowerCase();
  const source = $("f-source").value;
  const days = Number($("f-range").value);
  const alertsOnly = $("f-alerts").checked;
  const since = days ? Date.now() - days * 86400000 : 0;
  const minRank = minSeverity ? rankOf(minSeverity) : 0;
  return rows.filter((r) =>
    (!q || (r.label || "").toLowerCase().includes(q)) &&
    (!source || r.source === source) &&
    r.created_at >= since &&
    (!alertsOnly || r.alert) &&
    rankOf(r.severity) >= minRank);
}

function renderTiles() {
  const alerts = rows.filter((r) => r.alert).length;
  const worst = rows.reduce((m, r) => Math.max(m, r.coverage_pct), 0);
  const latest = rows[0];
  const tile = (value, label) => el("div", { class: "tile" },
    el("div", { class: "tile-value" }, value), el("div", { class: "tile-label" }, label));
  $("tiles").replaceChildren(
    tile(rows.length, "Checks saved"),
    tile(alerts, "Alerts"),
    tile(rows.length ? `${fmtPct(worst)}%` : "—", "Highest coverage"),
    tile(latest ? fmtWhen(latest.created_at).split(",")[0] : "—", "Last check"),
  );
}

function card(r) {
  const pill = el("span", { class: "sev-pill" });
  sevPill(pill, r.severity);
  return el("button", { class: "h-card", onclick: () => openDetail(r) },
    el("img", { class: "h-thumb", src: r.thumb ? objectUrl(r.thumb) : "", alt: "", loading: "lazy" }),
    el("div", { class: "h-body" },
      el("div", { class: "h-row" }, pill, el("span", { class: "h-pct" }, `${fmtPct(r.coverage_pct)}%`)),
      el("div", { class: "h-name" }, r.label || SOURCE_NAMES[r.source]),
      el("div", { class: "h-row" },
        el("span", { class: "h-meta" }, icon(r.source), fmtWhen(r.created_at)),
        r.alert ? el("span", { class: "h-alert" }, "Alert") : null)));
}

function render() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
  renderTiles();
  $("clear-history").disabled = !rows.length;
  const grid = $("history-grid");
  const list = filtered();
  if (!list.length) {
    grid.replaceChildren(el("div", { class: "empty history-empty" },
      el("h3", {}, rows.length ? "No checks match these filters" : "No checks yet"),
      el("p", {}, rows.length
        ? "Try widening the time range or severity."
        : "Analyze a photo or video, or run the live camera, and saved checks will appear here.")));
    return;
  }
  grid.replaceChildren(...list.map(card));
}

function openDetail(r) {
  const modal = $("modal");
  $("modal-img").src = r.image ? objectUrl(r.image) : (r.thumb ? objectUrl(r.thumb) : "");
  const pill = el("span", { class: "sev-pill" });
  sevPill(pill, r.severity);
  const scale = el("div", { class: "scale" });
  renderScale(scale, r.coverage_pct);
  const facts = [
    ["Coverage", `${fmtPct(r.coverage_pct)}%`],
    ["Water regions", r.regions ?? "—"],
    ["Source", SOURCE_NAMES[r.source] || r.source],
  ];
  if (r.video_time != null) facts.push(["Worst moment", fmtTime(r.video_time)]);
  $("modal-body").replaceChildren(
    el("div", { class: "h-row" },
      el("div", {}, el("h3", {}, r.label || SOURCE_NAMES[r.source]),
        el("div", { class: "muted" }, new Date(r.created_at).toLocaleString())),
      pill),
    scale,
    el("div", { class: "stats" }, facts.map(([k, v]) => statTile(k, v))),
    el("div", { class: "modal-actions" },
      el("button", {
        class: "btn btn-ghost", onclick: async () => {
          await store.remove(r.id);
          modal.close();
          toast("Check deleted.");
        },
      }, "Delete")));
  modal.showModal();
}

async function load() {
  try {
    rows = await store.all();
  } catch {
    rows = [];
    toast("History is unavailable in this browser (private mode?).", true);
  }
  render();
}

export function init() {
  ["f-search", "f-source", "f-range", "f-alerts"].forEach((id) =>
    $(id).addEventListener(id === "f-search" ? "input" : "change", render));
  $("f-severity").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    minSeverity = chip.dataset.sev;
    $("f-severity").querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c === chip));
    render();
  });
  $("clear-history").addEventListener("click", async () => {
    if (!rows.length || !confirm(`Delete all ${rows.length} saved checks from this device?`)) return;
    await store.clear();
    toast("History cleared.");
  });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").close(); });
  store.onChange(load);
  load();
}
