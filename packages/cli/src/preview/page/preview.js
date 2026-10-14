(() => {
  "use strict";

  const DEVICES = {
    mobile: { label: "Mobile", w: 390, h: 844, pad: 13, chrome: 0 },
    tablet: { label: "Tablet", w: 820, h: 1180, pad: 18, chrome: 0 },
    desktop: { label: "Desktop", w: 1440, h: 900, pad: 0, chrome: 38 },
  };
  const STATUS_TEXT = { starting: "Starting", running: "Running", stopped: "Stopped", error: "Error" };

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(`agnt0.preview.${k}`);
        return v === null ? d : v;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`agnt0.preview.${k}`, v);
      } catch {
        /* private mode */
      }
    },
  };

  let state = window.__AGNT0__ || {};
  let device = DEVICES[store.get("device", "mobile")] ? store.get("device", "mobile") : "mobile";
  let landscape = store.get("landscape", "0") === "1";
  let path = "/";
  let loadedSrc = "";

  const frame = $("frame");
  const overlay = $("overlay");

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url || "";
    }
  }

  function targetSrc() {
    if (!state.target_url) return "";
    const p = path.startsWith("/") ? path : `/${path}`;
    return state.target_url.replace(/\/+$/, "") + p;
  }

  function showOverlay(text, spinning) {
    $("overlay-text").textContent = text;
    overlay.classList.toggle("static", !spinning);
    overlay.classList.remove("hidden");
  }

  function setSrc(force) {
    const src = targetSrc();
    if (!src) return;
    if (force || src !== loadedSrc) {
      loadedSrc = src;
      if (frame.getAttribute("src") !== src || force) {
        showOverlay("Loading…", true);
        frame.setAttribute("src", src);
      }
    }
    $("open").href = src;
    $("chrome-url").textContent = hostOf(state.target_url) + (path === "/" ? "" : path);
  }

  frame.addEventListener("load", () => {
    if (frame.getAttribute("src")) overlay.classList.add("hidden");
  });

  function renderState() {
    const st = state.state || "starting";
    document.title = `${state.project || "Preview"} · Agent Zero`;
    $("project").textContent = state.project || "Preview";
    $("framework").textContent = state.label || "Dev server";
    const target = $("target");
    target.textContent = hostOf(state.target_url) || "…";
    if (state.target_url) target.href = state.target_url;
    $("status").textContent = STATUS_TEXT[st] || st;
    $("dot").className = `dot ${st}`;

    if (st === "running") setSrc(false);
    else if (st === "stopped") showOverlay("The preview stopped. Run agnt0 preview again to bring it back.", false);
    else if (st === "error") showOverlay(state.message || "The dev server hit a problem. Check your terminal.", false);
    else showOverlay("Waiting for the dev server…", true);

    const expo = $("expo");
    const hadExpo = !expo.hidden;
    if (state.expo_url) {
      expo.hidden = false;
      $("expo-url").textContent = state.expo_url;
      if (state.qr_svg && $("qr").dataset.for !== state.expo_url) {
        $("qr").innerHTML = state.qr_svg;
        $("qr").dataset.for = state.expo_url;
      }
    } else {
      expo.hidden = true;
    }
    if (hadExpo !== !expo.hidden) layout();
  }

  function renderDevice() {
    for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-selected", String(b.dataset.device === device));
    $("device").className = `device ${device}`;
    $("rotate").disabled = device === "desktop";
    layout();
  }

  function layout() {
    const d = DEVICES[device];
    // Space for the frame: the stage minus its padding, the caption and (when shown) the Expo card.
    const stage = $("stage");
    const cs = getComputedStyle(stage);
    const gap = parseFloat(cs.columnGap) || 0;
    const column = cs.flexDirection === "column";
    const expo = $("expo");
    const side = !expo.hidden && !column ? expo.offsetWidth + gap : 0;
    const above = !expo.hidden && column ? expo.offsetHeight + (parseFloat(cs.rowGap) || 0) : 0;
    const availW = Math.max(160, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - side);
    const availH = Math.max(160, stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - above - 40);
    let sw;
    let sh;
    if (device === "desktop") {
      sw = d.w;
      const s0 = Math.min(1, availW / sw);
      sh = Math.round(Math.min(1100, Math.max(600, availH / s0 - d.chrome)));
    } else {
      sw = landscape ? d.h : d.w;
      sh = landscape ? d.w : d.h;
    }
    const outerW = sw + d.pad * 2;
    const outerH = sh + d.pad * 2 + d.chrome;
    const s = Math.min(1, availW / outerW, availH / outerH);
    const el = $("device");
    el.style.width = `${outerW}px`;
    el.style.height = `${outerH}px`;
    el.style.transform = `scale(${s})`;
    const sizer = $("sizer");
    sizer.style.width = `${Math.round(outerW * s)}px`;
    sizer.style.height = `${Math.round(outerH * s)}px`;
    const orient = device === "desktop" ? "" : landscape ? " · landscape" : "";
    $("caption").textContent = `${d.label} · ${sw} × ${sh}${orient}${s < 0.995 ? ` · ${Math.round(s * 100)}%` : ""}`;
  }

  function pickDevice(name) {
    if (!DEVICES[name] || name === device) return;
    device = name;
    store.set("device", name);
    renderDevice();
  }

  function rotate() {
    if (device === "desktop") return;
    landscape = !landscape;
    store.set("landscape", landscape ? "1" : "0");
    layout();
  }

  for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => pickDevice(b.dataset.device));
  $("rotate").addEventListener("click", rotate);
  $("reload").addEventListener("click", () => setSrc(true));
  $("path-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("path").value.trim() || "/";
    path = v.startsWith("/") ? v : `/${v}`;
    $("path").value = path;
    $("path").blur();
    setSrc(true);
  });
  window.addEventListener("resize", layout);
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target && e.target.tagName === "INPUT")) return;
    if (e.key === "1") pickDevice("mobile");
    else if (e.key === "2") pickDevice("tablet");
    else if (e.key === "3") pickDevice("desktop");
    else if (e.key === "r" || e.key === "R") rotate();
  });

  async function poll() {
    try {
      const res = await fetch("/__agnt0/state", { cache: "no-store" });
      if (res.ok) {
        const next = await res.json();
        const changed = JSON.stringify(next) !== JSON.stringify(state);
        state = next;
        if (changed) renderState();
      }
    } catch {
      if (state.state !== "stopped") {
        state = { ...state, state: "stopped" };
        renderState();
      }
    }
    setTimeout(poll, 1500);
  }

  renderDevice();
  renderState();
  setTimeout(poll, 1500);
})();
