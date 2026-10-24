/*
 * hf-protocol — the HyperFrames page protocol, driven by RestorffCut's seek (part of @restorffcut/compositions, MIT).
 *
 * Injected into every page right after runtime.js. It gives a page written the HyperFrames way what HyperFrames'
 * own runtime would: paused timelines registered on window.__timelines[id] are seeked to the frame time; listeners of
 * the `hf-seek` event draw from `e.detail.time` (and may `e.detail.waitUntil(promise)`); Lottie instances pushed to
 * window.__hfLottie and Anime.js animations pushed to window.__hfAnime are seeked; promises in
 * window.__hf.buildReady are awaited before frame 0; window.__hyperframes.getVariables() answers the resolved params.
 *
 * Who drives it: the runtime calls RC.hf.seek(T) on every frame when the page registered no RC.composition (a bare
 * HyperFrames page). A composition that registers RC.composition and wants this behaviour calls RC.hf.seek(time.T)
 * from its render() and returns the result (a Promise when something asked to be waited for).
 *
 * Ideas (the protocol) from HyperFrames by HeyGen (Apache-2.0); no HyperFrames code is copied. Seeking a timeline
 * follows HyperFrames' documented order: pause it, prime it once just past 0 without events, then totalTime(t) with
 * events. Deterministic: no clock, no requestAnimationFrame.
 */
(function () {
  "use strict";
  var RC = window.RC;
  if (!RC || RC.hf) return;
  var cfg = window.__RC_CONFIG || null;

  window.__timelines = window.__timelines || {};
  if (!Array.isArray(window.__hfLottie)) window.__hfLottie = [];
  if (!Array.isArray(window.__hfAnime)) window.__hfAnime = [];
  if (window.__hf && !window.__hf.buildReady) window.__hf.buildReady = {};

  function declaredDefaults() {
    var out = {};
    try {
      var host = document.querySelector("[data-composition-variables]");
      var list = host ? JSON.parse(host.getAttribute("data-composition-variables") || "[]") : [];
      list.forEach(function (v) { if (v && v.id != null) out[v.id] = v.default; });
    } catch (e) { /* malformed declaration: no defaults */ }
    return out;
  }
  function variables() {
    var base = declaredDefaults();
    var params = (RC.params && Object.keys(RC.params).length ? RC.params : cfg && cfg.params) || {};
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(params).forEach(function (k) { out[k] = params[k]; });
    if (window.__hfVariables && typeof window.__hfVariables === "object" && window.__hfVariables !== out) {
      Object.keys(window.__hfVariables).forEach(function (k) { out[k] = window.__hfVariables[k]; });
    }
    return out;
  }
  // writable on purpose: a library kit may replace getVariables (fx-sync maps our camelCase keys back to upstream ids)
  if (!window.__hyperframes) {
    window.__hyperframes = {
      getVariables: variables,
      getDuration: function () { return RC.duration || (cfg && cfg.duration) || 0; },
      assetUrl: function (p) { return p; },
    };
  }

  /** Offset of a registered timeline: the numeric data-start of the element hosting that composition id. */
  function offsetOf(id) {
    try {
      var host = document.querySelector('[data-composition-id="' + String(id).replace(/"/g, '\\"') + '"]');
      var s = host && host.getAttribute("data-start");
      var n = s == null ? 0 : parseFloat(s);
      return isFinite(n) ? n : 0;
    } catch (e) { return 0; }
  }

  var primed = typeof WeakSet === "function" ? new WeakSet() : null;
  var errors = RC.errors || [];
  function note(where, e) { errors.push("hf-protocol " + where + ": " + (e && e.stack || e)); }

  function seekTimelines(T) {
    var reg = window.__timelines || {};
    Object.keys(reg).forEach(function (id) {
      var tl = reg[id];
      if (!tl || typeof tl.totalTime !== "function") return;
      var t = Math.max(0, T - offsetOf(id));
      try {
        if (typeof tl.pause === "function") tl.pause();
        if (primed && !primed.has(tl)) {
          primed.add(tl);
          // a paused timeline at its creation time ignores a seek to 0: move it just past 0 first, silently
          if (typeof tl.progress === "function") tl.progress(0.0001, true);
        }
        tl.totalTime(t, false);
      } catch (e) { note("timeline " + id, e); }
    });
    // our compat seeks its global timeline too, so gsap.to()/delayedCall() outside any timeline follow the frame time
    var g = window.gsap;
    if (g && g.__restorff && g.globalTimeline) {
      try { g.globalTimeline.totalTime(T, false); } catch (e) { note("global timeline", e); }
    }
  }
  function seekLottie(T) {
    window.__hfLottie.forEach(function (anim, i) {
      try {
        if (!anim || typeof anim.goToAndStop !== "function") return;
        var fr = anim.frameRate || (anim.animationData && anim.animationData.fr) || 30;
        var total = anim.totalFrames || (anim.animationData ? (anim.animationData.op - anim.animationData.ip) : 0) || 1;
        var f = T * fr;
        f = anim.loop ? f % total : Math.min(f, Math.max(0, total - 1));
        anim.goToAndStop(f, true);
      } catch (e) { note("lottie " + i, e); }
    });
  }
  function seekAnime(T) {
    window.__hfAnime.forEach(function (a, i) {
      try {
        if (!a || typeof a.seek !== "function") return;
        if (typeof a.pause === "function" && !a.__rcPaused) { a.pause(); a.__rcPaused = true; }
        a.seek(T * 1000);
      } catch (e) { note("anime " + i, e); }
    });
  }
  function dispatchSeek(T) {
    var waits = [];
    var ev;
    try {
      ev = new CustomEvent("hf-seek", { detail: { time: T, waitUntil: function (p) { if (p && typeof p.then === "function") waits.push(p); } } });
      window.dispatchEvent(ev);
    } catch (e) { note("hf-seek listener", e); }
    return waits;
  }

  var sawListener = false;
  var addEL = window.addEventListener;
  window.addEventListener = function (type) {
    if (type === "hf-seek") sawListener = true;
    return addEL.apply(this, arguments);
  };

  RC.hf = {
    /** Seek everything the HyperFrames protocol knows to T seconds. Returns a Promise when a listener asked to wait. */
    seek: function (T) {
      seekTimelines(T);
      seekAnime(T);
      seekLottie(T);
      var waits = dispatchSeek(T);
      if (!waits.length) return T;
      return Promise.all(waits).then(function () { return T; });
    },
    /** True when the page uses the protocol: a registered timeline, an hf-seek listener, a Lottie or Anime instance. */
    active: function () {
      return Object.keys(window.__timelines || {}).length > 0 || sawListener || window.__hfLottie.length > 0 ||
        window.__hfAnime.length > 0 || (window.gsap && window.gsap.__restorff && window.gsap.globalTimeline.getChildren(false).length > 0);
    },
    /** Promises in window.__hf.buildReady (heavy setup: meshes, shader compiles), awaited before frame 0. */
    ready: function () {
      var br = (window.__hf && window.__hf.buildReady) || {};
      var list = Object.keys(br).map(function (k) { return Promise.resolve(br[k]); });
      if (!list.length) return Promise.resolve();
      return Promise.all(list).then(function () {}, function (e) { note("buildReady", e); });
    },
    variables: variables,
  };
})();
