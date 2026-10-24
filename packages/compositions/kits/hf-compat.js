/*
 * hf-compat: the HyperFrames page protocol for compositions imported by fx-sync (tools/fx-sync).
 * Runs right after the RestorffCut runtime and before the page's scripts (library kit, CONTRACT.md §9c.6).
 * Implements, from HyperFrames' public docs (Apache-2.0, Copyright 2026 HeyGen, Inc., github.com/heygen-com/hyperframes,
 * docs/concepts/{compositions,data-attributes,variables,determinism}.mdx @fa5dbd1), the parts of its runtime that
 * registry items rely on. No HyperFrames runtime code is copied; written for RestorffCut (MIT).
 *
 * What a converted page gets:
 *   window.__hyperframes.getVariables() / window.__hfVariables  the composition's params under their upstream ids
 *   data-var-text / data-var-src bindings and --<id> CSS custom properties for scalar variables
 *   window.__timelines[id]  paused timelines, sought with totalTime(t, false) on every frame (any GSAP-compatible API)
 *   [data-start] clips      shown only inside [start, start + duration) (numbers or "<clip-id> ± s" references)
 *   RCHF.random()           the seeded stand-in fx-sync writes in place of the page's unseeded random calls
 *   frameFit                the upstream canvas (data-width × data-height) scaled into the render size, contain or cover
 *   backdrop                "transparent" clears the page / root backgrounds so the piece works as an overlay
 * Inline page scripts arrive as <script type="text/x-rc-deferred"> and run in build(), after fonts and bindings, in
 * document order; load / DOMContentLoaded listeners they add are called right after them.
 * The page calls RC.composition(RCHF.adapt()) at the end of its body.
 */
(function () {
  "use strict";
  if (window.RCHF) return;

  var DEFERRED = "text/x-rc-deferred";
  var cfg = window.__RC_CONFIG || null;
  var manifestCache = null;

  function manifest() {
    if (manifestCache) return manifestCache;
    var node = document.getElementById("params");
    try {
      manifestCache = node ? JSON.parse(node.textContent || "{}") : {};
    } catch (e) {
      manifestCache = {};
    }
    return manifestCache;
  }

  function ourParams() {
    if (window.RC && window.RC.params && Object.keys(window.RC.params).length) return window.RC.params;
    if (cfg && cfg.params) return cfg.params;
    var specs = manifest().params || {};
    var out = {};
    Object.keys(specs).forEach(function (k) { out[k] = specs[k].default; });
    return out;
  }

  /** Our params under their upstream ids (manifest.hf.vars: ourKey -> upstreamId). */
  function variables() {
    var map = (manifest().hf && manifest().hf.vars) || {};
    var p = ourParams();
    var out = {};
    Object.keys(map).forEach(function (k) {
      if (p[k] !== undefined) out[map[k]] = p[k];
    });
    return out;
  }

  // ---------------------------------------------------------------- seeded random (mulberry32), fixed seed per page
  var seedState = 0x2f6b9d1 >>> 0;
  function random() {
    seedState = (seedState + 0x6d2b79f5) >>> 0;
    var t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  window.__hyperframes = window.__hyperframes || {};
  window.__hyperframes.getVariables = function () { return variables(); };
  window.__timelines = window.__timelines || {};

  // ---------------------------------------------------------------- bindings
  function applyBindings(vars) {
    var root = document.documentElement;
    Object.keys(vars).forEach(function (id) {
      var v = vars[id];
      if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 200 && !/^(data|file):/i.test(v))) {
        try { root.style.setProperty("--" + id, String(v)); } catch (e) { /* invalid name */ }
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-var-text]"), function (el) {
      var id = el.getAttribute("data-var-text");
      if (Object.prototype.hasOwnProperty.call(vars, id) && vars[id] != null) el.textContent = String(vars[id]);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-var-src]"), function (el) {
      var id = el.getAttribute("data-var-src");
      if (Object.prototype.hasOwnProperty.call(vars, id) && vars[id]) el.setAttribute("src", String(vars[id]));
    });
  }

  // ---------------------------------------------------------------- fonts declared by the page (@font-face)
  function loadPageFonts() {
    if (!document.fonts) return Promise.resolve();
    var jobs = [];
    document.fonts.forEach(function (face) {
      if (face.status === "unloaded") jobs.push(face.load().catch(function () { /* missing: falls back */ }));
    });
    return Promise.all(jobs).then(function () { return document.fonts.ready; });
  }

  // ---------------------------------------------------------------- deferred inline scripts
  function runDeferred() {
    var queued = [];
    var wAdd = window.addEventListener;
    var dAdd = document.addEventListener;
    window.addEventListener = function (type, fn) {
      if (type === "load" || type === "DOMContentLoaded") { queued.push(fn); return undefined; }
      return wAdd.apply(window, arguments);
    };
    document.addEventListener = function (type, fn) {
      if (type === "DOMContentLoaded" || type === "readystatechange") { queued.push(fn); return undefined; }
      return dAdd.apply(document, arguments);
    };
    var list = Array.prototype.slice.call(document.querySelectorAll('script[type="' + DEFERRED + '"]'));
    try {
      list.forEach(function (old) {
        var s = document.createElement("script");
        for (var i = 0; i < old.attributes.length; i++) {
          var a = old.attributes[i];
          if (a.name !== "type") s.setAttribute(a.name, a.value);
        }
        s.text = old.text;
        old.parentNode.replaceChild(s, old); // an inline classic script runs synchronously here
      });
    } finally {
      window.addEventListener = wAdd;
      document.addEventListener = dAdd;
    }
    if (typeof window.onload === "function") queued.push(window.onload);
    queued.forEach(function (fn) {
      try {
        if (typeof fn === "function") fn.call(window, new Event("load"));
        else if (fn && typeof fn.handleEvent === "function") fn.handleEvent(new Event("load"));
      } catch (e) {
        if (window.RC) window.RC.errors.push("load handler: " + (e && e.stack || e));
      }
    });
  }

  // ---------------------------------------------------------------- clips: [data-start] windows
  var clips = [];
  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function resolveClips(rootEl, total) {
    var byId = {};
    var nodes = Array.prototype.slice.call(document.querySelectorAll("[data-start]"));
    nodes.forEach(function (el) { if (el.id) byId[el.id] = el; });
    var memo = new Map();
    function windowOf(el, depth) {
      if (memo.has(el)) return memo.get(el);
      if (depth > 32) return { start: 0, end: total };
      var raw = String(el.getAttribute("data-start") || "0").trim();
      var start = num(raw);
      if (start === null || !/^-?[\d.]+$/.test(raw)) {
        var m = /^([A-Za-z_][\w-]*)\s*(?:([+-])\s*([\d.]+))?$/.exec(raw);
        var ref = m && byId[m[1]];
        if (ref && ref !== el) {
          var w = windowOf(ref, depth + 1);
          start = w.end + (m[2] ? (m[2] === "-" ? -1 : 1) * parseFloat(m[3]) : 0);
        } else start = 0;
      }
      var dur = num(el.getAttribute("data-duration"));
      var res = { start: start, end: dur === null ? Infinity : start + dur };
      memo.set(el, res);
      return res;
    }
    clips = nodes
      .filter(function (el) { return el !== rootEl && !/^(VIDEO|AUDIO|SCRIPT|STYLE)$/.test(el.tagName); })
      .map(function (el) { var w = windowOf(el, 0); return { el: el, start: w.start, end: w.end }; });
  }
  function applyClips(t) {
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      var on = t >= c.start - 1e-9 && t < c.end - 1e-9;
      c.el.style.visibility = on ? "visible" : "hidden";
    }
  }

  // ---------------------------------------------------------------- timelines
  var timelines = [];
  function collectTimelines() {
    var reg = window.__timelines || {};
    if (Array.isArray(reg)) {
      var obj = {};
      reg.forEach(function (tl, i) { obj["timeline-" + i] = tl; });
      reg = obj;
    }
    timelines = [];
    Object.keys(reg).forEach(function (id) {
      var tl = reg[id];
      if (!tl || (typeof tl.totalTime !== "function" && typeof tl.seek !== "function")) return;
      try {
        // a timeline nested in another registered one is sought through its parent
        if (tl.parent && tl.parent.parent) return;
      } catch (e) { /* no parent API */ }
      var host = document.querySelector('[data-composition-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      var offset = host ? num(host.getAttribute("data-start")) || 0 : 0;
      if (host && host === rootOf()) offset = 0;
      timelines.push({ id: id, tl: tl, offset: offset });
    });
  }
  function seekTimelines(t) {
    for (var i = 0; i < timelines.length; i++) {
      var x = timelines[i];
      var local = Math.max(0, t - x.offset);
      if (typeof x.tl.totalTime === "function") x.tl.totalTime(local, false);
      else x.tl.seek(local, false);
    }
  }

  // ---------------------------------------------------------------- root, size fit, backdrop, theme
  function rootOf() {
    // a mounted sub-composition keeps data-composition-id on <html>: the root is the first one inside <body>
    return (document.body && document.body.querySelector("[data-composition-id]")) || document.body;
  }
  function px(v) {
    var n = parseFloat(v);
    return isFinite(n) && n > 0 ? n + "px" : "";
  }
  /** The stage layout HyperFrames' docs describe: the root sized from data-width/height and clipped; its timed
   * children stacked as absolute layers, full-size unless their CSS sizes them. Before any page script runs. */
  function applyStageLayout() {
    var root = rootOf();
    if (!root || root === document.body) return;
    var w = px(root.getAttribute("data-width"));
    var h = px(root.getAttribute("data-height"));
    if (w) root.style.width = w;
    if (h) root.style.height = h;
    if (!root.style.position && getComputedStyle(root).position === "static") root.style.position = "relative";
    root.style.overflow = "hidden";
    Array.prototype.forEach.call(root.children, function (el) {
      if (/^(SCRIPT|STYLE|LINK|META|AUDIO|TEMPLATE)$/.test(el.tagName) || !el.hasAttribute("data-start")) return;
      var cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed") el.style.position = "absolute";
      var fw = px(el.getAttribute("data-width"));
      var fh = px(el.getAttribute("data-height"));
      if (!el.style.width && (cs.width === "0px" || cs.width === "auto")) el.style.width = fw || "100%";
      if (!el.style.height && (cs.height === "0px" || cs.height === "auto")) el.style.height = fh || "100%";
    });
  }
  /* fx-sync:themes (generated from HyperFrames themes/*.css by tools/fx-sync; "restorff" is ours) */
  var THEMES = {
    "restorff": "--bg:#0C0C0E;--fg:#EDEBE6;--muted:#8C8C95;--surface:#16161A;--border:#222228;--brand:#F6FF00;--accent:#F6FF00;--accent-2:#C8553D;--font-display:'Archivo',sans-serif;--font-body:'Archivo',sans-serif;--font-mono:'JetBrains Mono',monospace;--radius:1.4cqmin;--space-1:1.2cqmin;--space-2:2.6cqmin;--space-3:4.6cqmin;--dur-beat:0.32s;--ease-standard:cubic-bezier(0.16,1,0.3,1);--ease-emphasis:cubic-bezier(0.34,1.56,0.64,1)",
    "bold": "--bg: #080611;--fg: #fff8ff;--muted: #b6a9ca;--surface: #1b1230;--border: #493668;--brand: #ff3d81;--accent: #7c5cff;--accent-2: #00d4ff;--font-display: Impact, Haettenschweiler, \"Arial Narrow Bold\", sans-serif;--font-body: Inter, \"Helvetica Neue\", Arial, sans-serif;--font-mono: \"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace;--radius: 1.4cqmin;--space-1: 1.2cqmin;--space-2: 2.6cqmin;--space-3: 4.6cqmin;--dur-beat: 0.32s;--ease-standard: cubic-bezier(0.16, 1, 0.3, 1);--ease-emphasis: cubic-bezier(0.34, 1.56, 0.64, 1)",
    "editorial": "--bg: #e9e1d2;--fg: #202725;--muted: #6c746f;--surface: #f8f1e5;--border: #c9bfad;--brand: #246b63;--accent: #31776f;--accent-2: #8a6549;--font-display: Georgia, \"Times New Roman\", serif;--font-body: \"Iowan Old Style\", \"Palatino Linotype\", Palatino, Georgia, serif;--font-mono: \"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace;--radius: 0.9cqmin;--space-1: 1.1cqmin;--space-2: 2.2cqmin;--space-3: 3.8cqmin;--dur-beat: 0.48s;--ease-standard: cubic-bezier(0.22, 0.61, 0.36, 1);--ease-emphasis: cubic-bezier(0.16, 1, 0.3, 1)",
    "neutral": "--bg: #f3f4f6;--fg: #111318;--muted: #626873;--surface: #fcfcfd;--border: #d7dbe2;--brand: #1d4ed8;--accent: #0284c7;--accent-2: #60a5fa;--font-display: Inter, \"Helvetica Neue\", Arial, sans-serif;--font-body: Inter, \"Helvetica Neue\", Arial, sans-serif;--font-mono: \"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace;--radius: 2.4cqmin;--space-1: 1.2cqmin;--space-2: 2.4cqmin;--space-3: 4cqmin;--dur-beat: 0.4s;--ease-standard: cubic-bezier(0.215, 0.61, 0.355, 1);--ease-emphasis: cubic-bezier(0.19, 1, 0.22, 1)"
  };
  /* /fx-sync:themes */
  function applyTheme(name) {
    if (!name || name === "none" || !THEMES[name]) return;
    var decl = THEMES[name].split(";").filter(Boolean).map(function (d) { return d + " !important"; }).join(";");
    var st = document.createElement("style");
    st.setAttribute("data-rchf", "theme-" + name);
    st.textContent = ":root,#root,[data-composition-id]{" + decl + "}";
    document.head.appendChild(st);
  }
  function fitToFrame(RC) {
    var hf = manifest().hf || {};
    var w0 = hf.width || RC.width;
    var h0 = hf.height || RC.height;
    var mode = RC.params.frameFit || "contain";
    var root = rootOf();
    if (RC.params.backdrop === "transparent") {
      var clear = document.createElement("style");
      clear.setAttribute("data-rchf", "backdrop");
      clear.textContent = "html,body{background:transparent!important}";
      document.head.appendChild(clear);
      if (root && root !== document.body) root.style.setProperty("background", "transparent", "important");
    }
    if (!root || root === document.body) return;
    if (w0 === RC.width && h0 === RC.height) return;
    var s = mode === "cover" ? Math.max(RC.width / w0, RC.height / h0) : Math.min(RC.width / w0, RC.height / h0);
    var wrap = document.createElement("div");
    wrap.id = "rchf-fit";
    wrap.style.cssText = "position:absolute;left:0;top:0;width:" + w0 + "px;height:" + h0 + "px;transform-origin:0 0;" +
      "transform:translate(" + (RC.width - w0 * s) / 2 + "px," + (RC.height - h0 * s) / 2 + "px) scale(" + s + ");overflow:hidden";
    root.parentNode.insertBefore(wrap, root);
    wrap.appendChild(root);
  }

  // ---------------------------------------------------------------- the composition
  function adapt() {
    return {
      build: function (RC) {
        var vars = variables();
        window.__hfVariables = vars;
        applyBindings(vars);
        applyTheme(RC.params.theme);
        var ownHf = window.__hf;
        return loadPageFonts()
          .then(function () {
            applyStageLayout();
            runDeferred();
            // a page that replaced window.__hf keeps its fields on ours (the renderer seeks through ours)
            if (window.__hf !== ownHf && window.__hf && typeof window.__hf === "object") {
              var theirs = window.__hf;
              Object.keys(theirs).forEach(function (k) { if (k !== "seek" && k !== "duration") ownHf[k] = theirs[k]; });
              window.__hf = ownHf;
            }
            // heavy setup the page asked to wait for (window.__hf.buildReady): the runtime's protocol awaits it
            if (window.RC && RC.hf && typeof RC.hf.ready === "function") return RC.hf.ready();
            var ready = ownHf && ownHf.buildReady;
            return ready && typeof ready.then === "function" ? ready : null;
          })
          .then(function () {
            fitToFrame(RC);
            resolveClips(rootOf(), RC.duration * Math.max(1, RC.rate));
            collectTimelines();
            if (!timelines.length && (manifest().hf || {}).needsTimeline) RC.errors.push("no timeline registered in window.__timelines");
          });
      },
      render: function (time) {
        applyClips(time.t);
        // the runtime's HyperFrames protocol (anim-runtime, src/gsap-compat/hf-protocol.js) seeks timelines, the gsap
        // global timeline, Lottie, Anime.js and hf-seek listeners; on animation time, so `speed` and fit apply
        if (window.RC && RC.hf && typeof RC.hf.seek === "function") return RC.hf.seek(time.t);
        seekTimelines(time.t);
        return undefined;
      },
    };
  }

  window.RCHF = { adapt: adapt, random: random, variables: variables, version: "0.1.0" };
})();
