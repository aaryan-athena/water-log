// Shell: navigation, service status, view wiring.

import * as api from "./api.js";
import * as analyze from "./analyze.js";
import * as live from "./live.js";
import * as historyView from "./history.js";
import { $ } from "./util.js";

const VIEWS = ["analyze", "live", "history"];

function show(name) {
  if (!VIEWS.includes(name)) name = "analyze";
  VIEWS.forEach((v) => $(`view-${v}`).classList.toggle("is-active", v === name));
  document.querySelectorAll(".seg").forEach((b) =>
    b.setAttribute("aria-selected", b.dataset.view === name ? "true" : "false"));
  // Release the camera when leaving the live view.
  if (name !== "live" && live.isRunning()) live.stop();
  if (location.hash !== `#${name}`) window.history.replaceState(null, "", `#${name}`);
}

async function checkStatus() {
  const box = $("status");
  const text = box.querySelector(".status-text");
  try {
    const res = await api.health();
    const ok = res.status === "ok";
    box.classList.toggle("is-ok", ok);
    box.classList.toggle("is-bad", !ok);
    text.textContent = ok ? "Ready" : "Model unavailable";
  } catch {
    box.classList.add("is-bad");
    text.textContent = "Offline";
  }
}

document.querySelectorAll(".seg").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
document.querySelector(".brand").addEventListener("click", (e) => { e.preventDefault(); show("analyze"); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

analyze.init();
live.init();
historyView.init();
show(location.hash.slice(1));
checkStatus();
