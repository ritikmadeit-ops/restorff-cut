/*
 * RestorffCut composition runtime — runs inside the page, before any composition script.
 *
 * The renderer injects `window.__RC_CONFIG` (resolved params, size, fps, duration, font bytes) and this file through
 * CDP `Page.addScriptToEvaluateOnNewDocument`. A composition can also include it with
 * <script src="../../src/runtime.js"></script> so the HTML file previews on its own in a browser (it then loops in
 * real time over a checkerboard; add ?t=1.2 to the URL to freeze one moment).
 *
 * Contract (CONTRACT.md): the composition calls RC.composition({ build, render }).
 *   build(RC)        once, after fonts load: create DOM from RC.params. May be async (await images there).
 *   render(time, RC) every frame: set styles from `time` only. Never read a clock, never use Math.random.
 * time = { T, t, left, p, frame, duration, rate }  (seconds; t/left run at `rate` = max(speed, fit / duration):
 *   the `speed` param, raised when the render is shorter than the composition's natural length — CONTRACT.md §3)
 *
 * Exposes window.__hf = { duration, seek(t) } — the page protocol the HyperFrames engine also renders.
 * Plain ES2020, no dependencies. Ideas from HyperFrames (Apache-2.0, Copyright 2026 HeyGen, Inc.); no code copied.
 */
(function () {
  "use strict";
  if (window.RC) return; // injected by the renderer and also included by <script src>: first one wins

  var cfg = window.__RC_CONFIG || null;
  var renderMode = !!cfg;
  var scriptSrc = document.currentScript && document.currentScript.src;
  var errors = [];

  window.addEventListener("error", function (e) {
    errors.push(String((e && e.message) || e) + (e && e.filename ? " @ " + e.filename + ":" + e.lineno : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    errors.push("unhandled rejection: " + String(e && e.reason && (e.reason.stack || e.reason)));
  });

  // ---------------------------------------------------------------- easing presets (names in types.ts EASINGS)
  var C1 = 1.70158;
  var C3 = C1 + 1;
  function outBounce(x) {
    var n1 = 7.5625;
    var d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
  }
  var SPRING_END = 1 - Math.exp(-6) * Math.cos(3 * Math.PI);
  var EASE = {
    linear: function (x) { return x; },
    smooth: function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
    gentle: function (x) { return Math.sin((x * Math.PI) / 2); },
    snappy: function (x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); },
    bouncy: function (x) { return 1 + C3 * Math.pow(x - 1, 3) + C1 * Math.pow(x - 1, 2); },
    springy: function (x) { return (1 - Math.exp(-6 * x) * Math.cos(3 * Math.PI * x)) / SPRING_END; },
    elastic: function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
    bounce: outBounce,
    "ease-in": function (x) { return x * x * x; },
  };

  // ---------------------------------------------------------------- math helpers (all pure)
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function mix(a, b, p) { return a + (b - a) * p; }
  function easeFn(e) {
    if (typeof e === "function") return e;
    return EASE[e] || EASE.smooth;
  }
  /** Eased 0..1 progress of a segment that starts at `start` and lasts `dur` (all in animation seconds). */
  function progress(t, start, dur, ease) {
    if (!(dur > 0)) return t >= start ? 1 : 0;
    return easeFn(ease)(clamp((t - start) / dur, 0, 1));
  }
  function tween(t, start, dur, from, to, ease) { return mix(from, to, progress(t, start, dur, ease)); }
  /** Seeded PRNG (mulberry32). Same seed, same sequence: the only randomness allowed. */
  function random(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hexToRgba(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3 || h.length === 4) h = h.split("").map(function (c) { return c + c; }).join("");
    var n = parseInt(h.slice(0, 6), 16);
    var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  /** "#F6FF00" + alpha 0..1 → "rgba(246,255,0,0.5)". */
  function alpha(hex, a) {
    var c = hexToRgba(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + +(c[3] * a).toFixed(4) + ")";
  }
  function mixColor(h1, h2, p) {
    var a = hexToRgba(h1);
    var b = hexToRgba(h2);
    return "rgba(" + Math.round(mix(a[0], b[0], p)) + "," + Math.round(mix(a[1], b[1], p)) + "," +
      Math.round(mix(a[2], b[2], p)) + "," + +mix(a[3], b[3], p).toFixed(4) + ")";
  }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }

  // ---------------------------------------------------------------- DOM helpers
  /** Tiny hyperscript: RC.el("div", { class: "card", style: { left: "10px" } }, [child, "text"]). */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else node.setAttribute(k, v === true ? "" : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  /** Set transform/opacity/filter in one go. Units: px, deg. Keys: x y z scale sx sy rotate rx ry skew opacity blur. */
  function set(node, s) {
    if (!node) return;
    var tf = "";
    // 2D translate unless z is asked for: translate3d promotes the element to its own compositor layer, whose
    // raster scale Chrome updates on its own schedule, so pixels depended on timing (LEARNINGS.md §2)
    if (s.z != null) tf += "translate3d(" + num(s.x, 0) + "px," + num(s.y, 0) + "px," + s.z + "px) ";
    else if (s.x != null || s.y != null) tf += "translate(" + num(s.x, 0) + "px," + num(s.y, 0) + "px) ";
    if (s.rotate != null) tf += "rotate(" + s.rotate + "deg) ";
    if (s.rx != null) tf += "rotateX(" + s.rx + "deg) ";
    if (s.ry != null) tf += "rotateY(" + s.ry + "deg) ";
    if (s.skew != null) tf += "skewX(" + s.skew + "deg) ";
    if (s.scale != null) tf += "scale(" + s.scale + ") ";
    if (s.sx != null || s.sy != null) tf += "scale(" + num(s.sx, 1) + "," + num(s.sy, 1) + ") ";
    if (tf || s.transform != null) node.style.transform = (s.transform || "") + " " + tf;
    if (s.opacity != null) node.style.opacity = String(clamp(s.opacity, 0, 1));
    if (s.blur != null) node.style.filter = s.blur > 0.01 ? "blur(" + s.blur + "px)" : "none";
    if (s.clip != null) node.style.clipPath = s.clip;
  }
  /** Shrink an element's font-size until its width fits `maxWidth` px. Deterministic (runs in build, fonts loaded). */
  function fitText(node, maxWidth, maxSize, minSize) {
    var size = maxSize;
    node.style.fontSize = size + "px";
    node.style.whiteSpace = "nowrap";
    var w = node.scrollWidth;
    if (w > maxWidth) {
      size = Math.max(minSize || 8, Math.floor((size * maxWidth) / w));
      node.style.fontSize = size + "px";
      for (var i = 0; i < 20 && node.scrollWidth > maxWidth && size > (minSize || 8); i++) {
        size -= 1;
        node.style.fontSize = size + "px";
      }
    }
    return size;
  }

  // ---------------------------------------------------------------- fonts (bundled in ../fonts, OFL)
  var FONT_FACES = [
    { family: "Archivo", file: "Archivo-Variable.woff2", d: { weight: "100 900", stretch: "62% 125%", style: "normal" } },
    { family: "JetBrains Mono", file: "JetBrainsMono-Variable.woff2", d: { weight: "100 800", style: "normal" } },
    { family: "Instrument Serif", file: "InstrumentSerif-Regular.woff2", d: { weight: "400", style: "normal" } },
    { family: "Instrument Serif", file: "InstrumentSerif-Italic.woff2", d: { weight: "400", style: "italic" } },
  ];
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function loadFonts() {
    if (!document.fonts || typeof FontFace === "undefined") return Promise.resolve();
    var base = (cfg && cfg.fontBase) || (scriptSrc ? new URL("../fonts/", scriptSrc).href : null);
    var jobs = FONT_FACES.map(function (f) {
      var src = cfg && cfg.fontData && cfg.fontData[f.file]
        ? b64ToBytes(cfg.fontData[f.file])
        : base ? "url(" + base + f.file + ")" : null;
      if (!src) return Promise.resolve();
      var face = new FontFace(f.family, src, f.d);
      document.fonts.add(face);
      return face.load().catch(function (e) { errors.push("font " + f.file + ": " + e); });
    });
    return Promise.all(jobs).then(function () { return document.fonts.ready; });
  }

  // ---------------------------------------------------------------- images: decode every <img> before frame 0
  function waitImages() {
    var imgs = Array.prototype.slice.call(document.images);
    return Promise.all(imgs.map(function (img) {
      if (!img.getAttribute("src")) return Promise.resolve();
      return (img.decode ? img.decode() : Promise.resolve()).catch(function () {
        errors.push("image failed to load: " + img.getAttribute("src"));
      });
    }));
  }

  // ---------------------------------------------------------------- safe areas (ASSUMPTION: see CONTRACT.md)
  function safeArea(w, h) {
    if (h / w > 1.5) {
      // 9:16 feeds: status bar/handle on top, caption + CTA at the bottom, action buttons on the right
      return { top: Math.round(h * 0.11), bottom: Math.round(h * 0.21), left: Math.round(w * 0.06), right: Math.round(w * 0.12) };
    }
    var m = Math.round(Math.min(w, h) * 0.05);
    return { top: m, bottom: m, left: m, right: m };
  }

  // ---------------------------------------------------------------- params
  function readManifest() {
    var node = document.getElementById("params");
    if (!node) return null;
    try { return JSON.parse(node.textContent || "{}"); } catch (e) { errors.push("params JSON: " + e.message); return null; }
  }
  function defaultsOf(manifest) {
    var out = {};
    var specs = (manifest && manifest.params) || {};
    Object.keys(specs).forEach(function (k) { out[k] = JSON.parse(JSON.stringify(specs[k].default)); });
    return out;
  }
  function kebab(s) { return s.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }); }

  // ---------------------------------------------------------------- the RC object
  var def = null;
  var resolveReady;
  var RC = {
    version: "0.1.0",
    renderMode: renderMode,
    params: {},
    manifest: null,
    width: 0,
    height: 0,
    /** Design unit: compositions are drawn on a 1080 grid; multiply px sizes by RC.u (CSS: calc(Npx * var(--u))). */
    u: 1,
    fps: 30,
    duration: 0,
    /**
     * Animation seconds per real second: max(speed, fit / duration). Equals the `speed` param unless the render is
     * shorter than the composition's natural length (`fit`), when the clock runs faster so every beat still happens.
     * A cue timed to the voice stays on time.T; its own animation can run at this rate: (T - at) * RC.rate.
     */
    rate: 1,
    /** How much fit-to-duration raised the clock: rate / speed (1 = not at all). */
    fit: 1,
    safe: { top: 0, bottom: 0, left: 0, right: 0 },
    time: 0,
    errors: errors,
    EASE: EASE,
    ease: function (name, x) { return easeFn(name)(clamp(x, 0, 1)); },
    clamp: clamp,
    mix: mix,
    progress: progress,
    tween: tween,
    random: random,
    alpha: alpha,
    mixColor: mixColor,
    el: el,
    set: set,
    fitText: fitText,
    /** Register the composition. Call once from the page's script. */
    composition: function (d) { def = d; },
    /**
     * Animation seconds since a cue at real time `at`: (T - at) * rate. A cue timed to the voice stays put; the little
     * animation it starts (a pop, a draw) runs at the clip's rate, so `speed` and fit-to-duration reach it too.
     */
    since: function (T, at) { return (T - at) * RC.rate; },
    /**
     * Real time of a cue param. A cue that would fall after the last frame of a fitted (shortened) render was timed
     * for the natural length: it is fitted with the rest of the clock (at / fit). A cue inside the window stays on the
     * voice. Lists: RC.cues([...]) fits all of them together when the latest one falls outside.
     */
    cue: function (at) { return RC.cues([at])[0]; },
    cues: function (list) {
      var last = RC.duration - 0.5 / RC.fps;
      var late = RC.fit > 1 && list.some(function (a) { return typeof a === "number" && a >= last; });
      return list.map(function (a) { return late && typeof a === "number" ? a / RC.fit : a; });
    },
  };
  RC.ready = new Promise(function (r) { resolveReady = r; });
  window.RC = RC;

  function frameTime(T) {
    var rate = RC.rate;
    var last = Math.max(0, RC.duration - 1 / RC.fps);
    return {
      T: T,
      t: T * rate,
      left: Math.max(0, last - T) * rate,
      p: RC.duration > 0 ? T / RC.duration : 0,
      frame: Math.round(T * RC.fps),
      duration: RC.duration,
      rate: rate,
    };
  }
  /** rate = max(speed, fit / duration); cfg.fit = the natural length the renderer fitted from (0 = none). */
  function clockRate() {
    var speed = num(RC.params.speed, 1);
    if (!(speed > 0)) speed = 1;
    var fit = cfg && typeof cfg.fit === "number" && cfg.fit > 0 && RC.duration > 0 ? cfg.fit / RC.duration : 0;
    return Math.max(speed, fit);
  }

  function seek(T) {
    T = clamp(+T || 0, 0, RC.duration);
    var time = frameTime(T);
    var anims = document.getAnimations ? document.getAnimations() : [];
    for (var i = 0; i < anims.length; i++) {
      try { anims[i].pause(); anims[i].currentTime = time.t * 1000; } catch (e) { /* finished/cancelled */ }
    }
    var wait = null;
    if (def && typeof def.render === "function") {
      try { wait = def.render(time, RC); } catch (e) { errors.push("render(" + T.toFixed(3) + "): " + (e && e.stack || e)); }
    } else if (RC.hf) {
      // a bare HyperFrames page (window.__timelines, hf-seek, Lottie, Anime): gsap-compat/hf-protocol.js seeks it
      try { wait = RC.hf.seek(time.t); } catch (e) { errors.push("hf seek(" + T.toFixed(3) + "): " + (e && e.stack || e)); }
    }
    RC.time = T;
    // a Promise (an hf-seek listener asked to wait, or render() returned one) is awaited by the renderer
    if (wait && typeof wait.then === "function") {
      return wait.then(function () { return T; }, function (e) { errors.push("seek(" + T.toFixed(3) + "): " + (e && e.stack || e)); return T; });
    }
    return T;
  }

  var ownHf = {
    get duration() { return RC.duration; },
    seek: seek,
    buildReady: {}, // HyperFrames: heavy setup registers a promise here; awaited before frame 0 (hf-protocol.js)
  };
  window.__hf = ownHf;
  /** A page that sets its own window.__hf = { duration, seek(t) } (the bare HyperFrames protocol, no RC.composition). */
  function rawProtocol() {
    var hf = window.__hf;
    return !def && hf && hf !== ownHf && typeof hf.seek === "function";
  }

  function baseStyle() {
    var s = RC.safe;
    var css = ":root{--w:" + RC.width + "px;--h:" + RC.height + "px;--u:" + RC.u + ";--safe-top:" + s.top + "px;--safe-bottom:" +
      s.bottom + "px;--safe-left:" + s.left + "px;--safe-right:" + s.right + "px;" +
      "--screen:#0C0C0E;--screen-2:#16161A;--screen-3:#222228;--bone:#EDEBE6;--fog:#8C8C95;--neon:#F6FF00;" +
      "--stale:#E8A33D;--kiln:#C8553D;";
    Object.keys(RC.params).forEach(function (k) {
      var v = RC.params[k];
      if (typeof v === "number") css += "--p-" + kebab(k) + ":" + v + ";";
      else if (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v)) css += "--p-" + kebab(k) + ":" + v + ";";
    });
    css += "}html,body{margin:0;padding:0;width:" + RC.width + "px;height:" + RC.height + "px;overflow:hidden;" +
      "background:transparent;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}" +
      "*{box-sizing:border-box}";
    var st = document.createElement("style");
    st.id = "__rc_base";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function previewLoop() {
    // Standalone preview in a normal browser: checkerboard plate, real-time loop, ?t= to freeze.
    document.documentElement.style.background =
      "repeating-conic-gradient(#3a3a40 0% 25%, #2a2a2e 0% 50%) 50% / 40px 40px";
    var q = new URLSearchParams(location.search);
    var go = RC.rawProtocol ? function (t) { window.__hf.seek(t); } : seek;
    if (q.has("t")) { go(parseFloat(q.get("t"))); return; }
    var start = performance.now(); // preview only; never used by the renderer
    function tick(now) {
      go(((now - start) / 1000) % RC.duration);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function init() {
    var manifest = readManifest();
    RC.manifest = manifest;
    RC.params = (cfg && cfg.params) || defaultsOf(manifest);
    var size = (manifest && manifest.size) || [window.innerWidth, window.innerHeight];
    RC.width = (cfg && cfg.width) || size[0];
    RC.height = (cfg && cfg.height) || size[1];
    RC.fps = (cfg && cfg.fps) || (manifest && manifest.fps) || 30;
    RC.duration = (cfg && cfg.duration) || (manifest && manifest.duration) || 3;
    RC.u = Math.min(RC.width, RC.height) / 1080;
    RC.safe = safeArea(RC.width, RC.height);
    RC.rate = clockRate();
    RC.fit = RC.rate / (num(RC.params.speed, 1) > 0 ? num(RC.params.speed, 1) : 1);
    baseStyle();
    return loadFonts()
      .then(function () { return def && typeof def.build === "function" ? def.build(RC) : null; })
      .then(waitImages)
      .then(function () { return RC.hf && RC.hf.ready ? RC.hf.ready() : null; })
      .then(function () {
        if (rawProtocol()) {
          RC.rawProtocol = true;
          try { return window.__hf.seek(0); } catch (e) { errors.push("__hf.seek(0): " + (e && e.stack || e)); }
        } else {
          if (!def && !(RC.hf && RC.hf.active())) errors.push("no composition registered: call RC.composition({ build, render }), set window.__hf = { duration, seek(t) }, or register a paused timeline on window.__timelines (HyperFrames)");
          return seek(0);
        }
      })
      .then(function () {
        var result = { ok: errors.length === 0, errors: errors.slice(), width: RC.width, height: RC.height, duration: RC.duration };
        resolveReady(result);
        if (!renderMode) previewLoop();
        return result;
      })
      .catch(function (e) {
        errors.push("build: " + (e && e.stack || e));
        resolveReady({ ok: false, errors: errors.slice() });
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else Promise.resolve().then(init);
})();
