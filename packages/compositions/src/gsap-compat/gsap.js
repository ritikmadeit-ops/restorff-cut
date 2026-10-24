/*
 * gsap-compat — RestorffCut's own implementation of the part of the GSAP 3 API that HyperFrames blocks use.
 * Part of @restorffcut/compositions (MIT). Status and the supported API: ./STATUS.md. How to include: <!-- rc-lib gsap -->
 *
 * CLEAN ROOM. Written from GSAP's public documentation (gsap.com/docs/v3) and from black-box observation of real GSAP's
 * outputs (style strings, values, callback order) in a scratchpad browser. GSAP's source code was never opened, read
 * or copied. "GSAP" is a trademark of its owner; this project is not affiliated with or endorsed by it.
 *
 * DETERMINISTIC AND SEEKABLE. Nothing moves on a clock: there is no ticker loop and no requestAnimationFrame. An
 * animation changes only when seek() / totalTime() / time() / progress() is called — the renderer's window.__hf.seek
 * drives the timelines registered on window.__timelines. Every render is a function of the target time (children are
 * rendered in start order, later starts win), so the same seek gives the same frame whatever was seeked before
 * (overlapping tweens on one property excepted, see STATUS.md). Randomness (stagger from:"random", utils.random,
 * utils.shuffle, "random(…)" values) comes from a PRNG seeded per composition.
 *
 * Plain ES2015, no dependencies. Exposes window.gsap and the plugin globals (CustomEase, MotionPathPlugin, …).
 */
(function (root) {
  "use strict";
  if (root.gsap && root.gsap.__restorff) return; // included twice (marker + preview <script>): first one wins

  var COMPAT_VERSION = "0.1.0";
  var _2PI = Math.PI * 2;
  var DEG = 180 / Math.PI;
  var BIG = 1e10; // stand-in for an infinite repeat's length

  // ================================================================ small helpers
  function isFn(v) { return typeof v === "function"; }
  function isStr(v) { return typeof v === "string"; }
  function isNum(v) { return typeof v === "number"; }
  function isObj(v) { return v !== null && typeof v === "object"; }
  function isEl(v) { return !!v && v.nodeType === 1 && !!v.style; }
  function isSvgChild(el) { return !!el && !!el.ownerSVGElement && typeof el.getBBox === "function"; }
  function clamp(min, max, v) { return v < min ? min : v > max ? max : v; }
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function r5(v) { return Math.round(v * 100000) / 100000; }
  function r6(v) { return Math.round(v * 1000000) / 1000000; }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
  function kebab(s) { return s.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }); }
  function warn(msg) { try { console.warn("gsap-compat: " + msg); } catch (e) { /* no console */ } }
  function assign(a) {
    for (var i = 1; i < arguments.length; i++) {
      var b = arguments[i];
      if (b) for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    }
    return a;
  }
  function getUnit(v) {
    if (!isStr(v)) return "";
    var m = v.match(/^[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?\s*([a-z%]+)\s*$/i);
    return m ? m[1] : "";
  }
  var NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  function parseNum(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ---------------------------------------------------------------- seeded randomness (per composition)
  var _rngState = null;
  function seedOf() {
    var cfg = root.__RC_CONFIG;
    if (cfg && cfg.params && isNum(cfg.params.seed)) return cfg.params.seed >>> 0;
    var key = "restorff";
    try {
      var host = document.querySelector("[data-composition-id]");
      if (host) key = host.getAttribute("data-composition-id") || key;
      else if (cfg && cfg.params && isStr(cfg.params.name)) key = cfg.params.name;
    } catch (e) { /* no document yet */ }
    var h = 2166136261;
    for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rand() {
    if (_rngState === null) _rngState = seedOf() || 1;
    _rngState = (_rngState + 0x6d2b79f5) >>> 0; // mulberry32
    var t = _rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- colours
  var NAMED = {
    transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1],
    green: [0, 128, 0, 1], blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1],
    purple: [128, 0, 128, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], cyan: [0, 255, 255, 1],
    magenta: [255, 0, 255, 1], lime: [0, 255, 0, 1], pink: [255, 192, 203, 1], navy: [0, 0, 128, 1],
    silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1], teal: [0, 128, 128, 1],
    aqua: [0, 255, 255, 1], fuchsia: [255, 0, 255, 1],
  };
  var _ctx = null;
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function c(t) {
      t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    }
    return [Math.round(c(h + 1 / 3) * 255), Math.round(c(h) * 255), Math.round(c(h - 1 / 3) * 255)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  /** "#f80", "rgb(…)", "hsla(…)", "red" → { c: [r, g, b, a], hsl: [h, s, l] | null } or null. */
  function parseColor(v) {
    if (!isStr(v)) return null;
    var s = v.trim().toLowerCase();
    var m;
    if (s[0] === "#") {
      var h = s.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split("").map(function (x) { return x + x; }).join("");
      if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return null;
      var n = parseInt(h.slice(0, 6), 16);
      return { c: [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? r4(parseInt(h.slice(6), 16) / 255) : 1], hsl: null };
    }
    if ((m = s.match(/^rgba?\(([^)]*)\)$/))) {
      var p = m[1].split(/[\s,/]+/).filter(Boolean);
      var f = function (x, i) { return x.indexOf("%") > 0 ? (i < 3 ? parseFloat(x) * 2.55 : parseFloat(x) / 100) : parseFloat(x); };
      return { c: [f(p[0], 0), f(p[1], 1), f(p[2], 2), p.length > 3 ? f(p[3], 3) : 1], hsl: null };
    }
    if ((m = s.match(/^hsla?\(([^)]*)\)$/))) {
      var q = m[1].split(/[\s,/]+/).filter(Boolean);
      var hh = parseFloat(q[0]), ss = parseFloat(q[1]) / 100, ll = parseFloat(q[2]) / 100;
      var a = q.length > 3 ? (q[3].indexOf("%") > 0 ? parseFloat(q[3]) / 100 : parseFloat(q[3])) : 1;
      var rgb = hslToRgb(hh, ss, ll);
      return { c: [rgb[0], rgb[1], rgb[2], a], hsl: [hh, ss, ll] };
    }
    if (NAMED[s]) return { c: NAMED[s].slice(), hsl: null };
    if (/^[a-z]+$/.test(s)) {
      try {
        if (!_ctx) _ctx = document.createElement("canvas").getContext("2d");
        _ctx.fillStyle = "#010203";
        _ctx.fillStyle = s;
        var out = _ctx.fillStyle;
        if (out !== "#010203" || s === "#010203") return parseColor(out);
      } catch (e) { /* no canvas */ }
    }
    return null;
  }
  function rgbaStr(c, spaces) {
    var sep = spaces ? ", " : ",";
    return "rgba(" + Math.round(c[0]) + sep + Math.round(c[1]) + sep + Math.round(c[2]) + sep + r4(c[3]) + ")";
  }
  function mixColor(a, b, p, spaces) {
    if (b.hsl) {
      var ha = a.hsl || rgbToHsl(a.c[0], a.c[1], a.c[2]);
      var hb = b.hsl;
      var rgb = hslToRgb(ha[0] + (hb[0] - ha[0]) * p, ha[1] + (hb[1] - ha[1]) * p, ha[2] + (hb[2] - ha[2]) * p);
      return rgbaStr([rgb[0], rgb[1], rgb[2], a.c[3] + (b.c[3] - a.c[3]) * p], spaces);
    }
    return rgbaStr([0, 1, 2, 3].map(function (i) { return a.c[i] + (b.c[i] - a.c[i]) * p; }), spaces);
  }

  // ---------------------------------------------------------------- complex strings ("blur(4px) brightness(2)")
  var COLOR_IN_STR = /#(?:[0-9a-f]{3,4}){1,2}\b|(?:rgba?|hsla?)\([^)]*\)|\b(?:transparent|black|white|red|green|blue|yellow|orange|purple|gray|grey|cyan|magenta|lime|pink|navy|silver|maroon|olive|teal|aqua|fuchsia)\b/gi;
  /** Split a string into literal text, numbers and colours. */
  function tokenize(str) {
    var out = [];
    var s = String(str);
    var re = new RegExp(COLOR_IN_STR.source + "|" + NUM_RE.source, "gi");
    var last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ t: "s", v: s.slice(last, m.index) });
      var tok = m[0];
      var col = /^[#a-z]/i.test(tok) ? parseColor(tok) : null;
      if (col) out.push({ t: "c", v: col });
      else out.push({ t: "n", v: parseFloat(tok) });
      last = m.index + tok.length;
    }
    if (last < s.length) out.push({ t: "s", v: s.slice(last) });
    return out;
  }
  var EMPTYISH = /^(?:none|normal|auto|initial|unset|)$/i;
  /** A function (p) → string interpolating every number and colour of `a` towards `b` (b's text wins). */
  function complexInterp(a, b, spaces) {
    var tb = tokenize(b);
    var ta = EMPTYISH.test(String(a).trim()) ? tb.map(function (t) {
      return t.t === "n" ? { t: "n", v: 0 } : t.t === "c" ? { t: "c", v: { c: [0, 0, 0, 0], hsl: null } } : t;
    }) : tokenize(a);
    var na = ta.filter(function (t) { return t.t === "n"; });
    var ca = ta.filter(function (t) { return t.t === "c"; });
    var ni = 0, ci = 0;
    var parts = tb.map(function (t) {
      if (t.t === "n") { var s = na[ni++]; return { t: "n", a: s ? s.v : 0, b: t.v }; }
      if (t.t === "c") { var c = ca[ci++]; return { t: "c", a: c ? c.v : { c: [0, 0, 0, 0], hsl: null }, b: t.v }; }
      return t;
    });
    return function (p) {
      var s = "";
      for (var i = 0; i < parts.length; i++) {
        var q = parts[i];
        if (q.t === "s") s += q.v;
        else if (q.t === "n") s += p === 1 ? q.b : r4(q.a + (q.b - q.a) * p);
        else s += p === 1 && !q.b.hsl ? rgbaStr(q.b.c, spaces) : mixColor(q.a, q.b, p, spaces);
      }
      return s;
    };
  }
  function hasNumOrColor(s) { return isStr(s) && (/\d/.test(s) || !!parseColor(s.trim())); }

  // ================================================================ eases
  function makeEase(easeIn) {
    return {
      in: easeIn,
      out: function (p) { return 1 - easeIn(1 - p); },
      inOut: function (p) { return p < 0.5 ? easeIn(p * 2) / 2 : 1 - easeIn((1 - p) * 2) / 2; },
    };
  }
  function powerIn(n) { return function (p) { return Math.pow(p, n); }; }
  function bounceOut(p) {
    var n1 = 7.5625, d1 = 2.75;
    if (p < 1 / d1) return n1 * p * p;
    if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
    if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
    return n1 * (p -= 2.625 / d1) * p + 0.984375;
  }
  var EASES = {};
  function registerFamily(name, set) {
    EASES[name + ".in"] = set.in;
    EASES[name + ".out"] = set.out;
    EASES[name + ".inOut"] = set.inOut;
    EASES[name] = set.out;
  }
  var linear = function (p) { return p; };
  EASES.none = EASES.linear = linear;
  registerFamily("power0", { in: linear, out: linear, inOut: linear });
  registerFamily("power1", makeEase(powerIn(2)));
  registerFamily("power2", makeEase(powerIn(3)));
  registerFamily("power3", makeEase(powerIn(4)));
  registerFamily("power4", makeEase(powerIn(5)));
  registerFamily("quad", makeEase(powerIn(2)));
  registerFamily("cubic", makeEase(powerIn(3)));
  registerFamily("quart", makeEase(powerIn(4)));
  registerFamily("quint", makeEase(powerIn(5)));
  registerFamily("strong", makeEase(powerIn(5)));
  registerFamily("sine", makeEase(function (p) { return p === 1 ? 1 : 1 - Math.cos(p * Math.PI / 2); }));
  // expo: GSAP's curve is not the textbook 2^(10(p−1)) (expo.in(0.5) is 0.0234, not 0.03125). Fitted to 201
  // black-box samples of GSAP 3.14.2's expo.in (oracle probes/expo.js): the ratio r(p) = f(p) / 2^(10(p−1)) at 21
  // knots, cubic Hermite between them. Max error 2.9e-4 of the travel (textbook formula: 7.8e-3).
  var EXPO_R = [0, 0.050011, 0.100461, 0.153505, 0.213107, 0.283146, 0.365318, 0.458148, 0.557286, 0.656682, 0.75,
    0.831854, 0.898598, 0.948644, 0.982358, 1.0017, 1.009715, 1.010011, 1.006288, 1.001979, 1];
  function expoIn(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    var n = EXPO_R.length - 1, x = p * n, i = Math.min(n - 1, Math.floor(x)), t = x - i;
    var y0 = EXPO_R[i], y1 = EXPO_R[i + 1];
    var m0 = i > 0 ? (EXPO_R[i + 1] - EXPO_R[i - 1]) / 2 : y1 - y0;
    var m1 = i + 2 <= n ? (EXPO_R[i + 2] - EXPO_R[i]) / 2 : y1 - y0;
    var r = (2 * t * t * t - 3 * t * t + 1) * y0 + (t * t * t - 2 * t * t + t) * m0 + (-2 * t * t * t + 3 * t * t) * y1 + (t * t * t - t * t) * m1;
    return r * Math.pow(2, 10 * (p - 1));
  }
  registerFamily("expo", makeEase(expoIn));
  registerFamily("circ", makeEase(function (p) { return -(Math.sqrt(1 - p * p) - 1); }));
  var bounceIn = function (p) { return 1 - bounceOut(1 - p); };
  registerFamily("bounce", { in: bounceIn, out: bounceOut, inOut: function (p) { return p < 0.5 ? bounceIn(p * 2) / 2 : 1 - bounceIn((1 - p) * 2) / 2; } });
  function backIn(s) { return function (p) { return p * p * ((s + 1) * p - s); }; }
  function elasticOut(a, per) {
    var amp = a >= 1 ? a : 1;
    var s = per / _2PI * (Math.asin(1 / amp) || 0);
    return function (p) { return p === 0 ? 0 : p === 1 ? 1 : amp * Math.pow(2, -10 * p) * Math.sin((p - s) * _2PI / per) + 1; };
  }
  /** "back.out(2.4)", "elastic.inOut(1, 0.45)", "steps(5)" → function, or null. */
  function configEase(name) {
    var m = name.match(/^([a-z]+)(?:\.(in|out|inout|easein|easeout|easeinout))?\s*\(([^)]*)\)$/i);
    if (!m) return null;
    var fam = m[1].toLowerCase();
    var type = (m[2] || "out").toLowerCase().replace("ease", "");
    var args = m[3].split(",").map(function (x) { return parseFloat(x); });
    var set;
    if (fam === "back") set = makeEase(backIn(isNaN(args[0]) ? 1.70158 : args[0]));
    else if (fam === "elastic") {
      var a = isNaN(args[0]) ? 1 : args[0];
      var per = isNaN(args[1]) ? (type === "inout" ? 0.45 : 0.3) : args[1];
      var out = elasticOut(a, per);
      set = { in: function (p) { return 1 - out(1 - p); }, out: out };
      set.inOut = function (p) { return p < 0.5 ? (1 - out(1 - p * 2)) / 2 : 0.5 + out(p * 2 - 1) / 2; };
    } else if (fam === "steps") {
      var n = Math.max(1, Math.round(args[0]) || 1);
      var st = function (p) { return Math.min(1, Math.floor(p * (n + 1)) / n); };
      return st;
    } else if (fam === "power" || EASES[fam]) return EASES[fam + "." + (type === "inout" ? "inOut" : type)] || null;
    else return null;
    return type === "in" ? set.in : type === "inout" ? set.inOut : set.out;
  }
  EASES["back.in"] = backIn(1.70158);
  registerFamily("back", makeEase(backIn(1.70158)));
  registerFamily("elastic", { in: configEase("elastic.in(1, 0.3)"), out: configEase("elastic.out(1, 0.3)"), inOut: configEase("elastic.inOut(1, 0.45)") });
  var LEGACY = { easein: "in", easeout: "out", easeinout: "inOut", easenone: "" };
  /** Ease name, function or undefined → function. Unknown names fall back to power1.out (with a warning). */
  function parseEase(e, fallback) {
    if (isFn(e)) return e;
    if (e == null || e === "") return fallback || EASES["power1.out"];
    var name = String(e).trim();
    if (EASES[name]) return EASES[name];
    var lower = name.toLowerCase();
    var dot = lower.split(".");
    if (dot.length === 2 && LEGACY[dot[1]] !== undefined) {
      if (dot[0] === "linear") return linear;
      var mapped = dot[0] + (LEGACY[dot[1]] ? "." + LEGACY[dot[1]] : "");
      if (EASES[mapped]) return EASES[mapped];
    }
    if (EASES[lower]) return EASES[lower];
    if (dot.length === 2) {
      var key = dot[0] + "." + (dot[1] === "inout" ? "inOut" : dot[1]);
      if (EASES[key]) return EASES[key];
    }
    var cfg = configEase(name);
    if (cfg) return (EASES[name] = cfg);
    warn('unknown ease "' + name + '", using power1.out');
    return fallback || EASES["power1.out"];
  }

  // ================================================================ targets
  function toArray(v, scope) {
    if (v == null) return [];
    if (isStr(v)) {
      try { return Array.prototype.slice.call((scope && scope.querySelectorAll ? scope : document).querySelectorAll(v)); }
      catch (e) { warn('invalid selector "' + v + '"'); return []; }
    }
    if (Array.isArray(v)) {
      var out = [];
      v.forEach(function (x) {
        if (isStr(x) || (x && !isEl(x) && typeof x.length === "number" && !Array.isArray(x) && x !== root)) out.push.apply(out, toArray(x, scope));
        else out.push(x);
      });
      return out;
    }
    if (typeof v.length === "number" && !isEl(v) && v !== root && !isStr(v) && typeof v.item === "function") return Array.prototype.slice.call(v);
    if (typeof v.length === "number" && !isEl(v) && v !== root && v.jquery) return Array.prototype.slice.call(v);
    return [v];
  }
  function uniqueTargets(v) {
    var list = toArray(v);
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] != null && out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }

  // ================================================================ transforms (per element cache)
  var CACHE = new WeakMap();
  var TRANSFORM_KEYS = {
    x: "x", y: "y", z: "z", xPercent: "xPercent", yPercent: "yPercent", rotation: "rotation", rotate: "rotation",
    rotationZ: "rotation", rotateZ: "rotation", rotationX: "rotationX", rotateX: "rotationX", rotationY: "rotationY",
    rotateY: "rotationY", skewX: "skewX", skewY: "skewY", scaleX: "scaleX", scaleY: "scaleY", scale: "scale",
    transformPerspective: "transformPerspective",
  };
  function readIndividual(cs) {
    var m = new DOMMatrix();
    try {
      var t = cs.translate, r = cs.rotate, s = cs.scale;
      if (t && t !== "none") { var tp = t.split(/\s+/).map(parseNum); m.translateSelf(tp[0] || 0, tp[1] || 0, tp[2] || 0); }
      if (r && r !== "none") { var rp = r.split(/\s+/); var deg = parseFloat(rp[rp.length - 1]); if (/rad$/.test(rp[rp.length - 1])) deg *= DEG; if (rp.length === 1 || rp[0] === "z") m.rotateSelf(0, 0, deg); }
      if (s && s !== "none") { var sp = s.split(/\s+/).map(parseNum); m.scaleSelf(sp[0], sp.length > 1 ? sp[1] : sp[0]); }
    } catch (e) { /* older engines */ }
    return m;
  }
  function decompose2d(a, b, c, d, e, f, cache) {
    var sx = Math.sqrt(a * a + b * b);
    var rot = Math.atan2(b, a);
    var cos = Math.cos(rot), sin = Math.sin(rot);
    var sy = -sin * c + cos * d;
    var skew = sy ? Math.atan((cos * c + sin * d) / sy) : 0;
    cache.x = e; cache.y = f;
    cache.scaleX = r5(sx); cache.scaleY = r5(sy);
    cache.rotation = r4(rot * DEG);
    cache.skewX = r4(skew * DEG);
    if (Math.abs(cache.rotation) < 1e-4) cache.rotation = 0;
    if (Math.abs(cache.skewX) < 1e-4) cache.skewX = 0;
  }
  function svgOriginFor(el, cache, spec, absolute) {
    var bb;
    try { bb = el.getBBox(); } catch (e) { bb = { x: 0, y: 0, width: 0, height: 0 }; }
    if (absolute) {
      var pa = String(spec).trim().split(/[\s,]+/).map(parseNum);
      cache.ox = pa[0] || 0; cache.oy = pa.length > 1 ? pa[1] : pa[0] || 0;
      return;
    }
    var parts = normOrigin(spec).split(" ");
    var px = parts[0], py = parts[1];
    cache.ox = bb.x + (px.indexOf("%") > 0 ? parseFloat(px) / 100 * bb.width : parseFloat(px));
    cache.oy = bb.y + (py.indexOf("%") > 0 ? parseFloat(py) / 100 * bb.height : parseFloat(py));
  }
  function getCache(el) {
    var cache = CACHE.get(el);
    if (cache) return cache;
    cache = { x: 0, y: 0, z: 0, xu: "px", yu: "px", xPercent: 0, yPercent: 0, rotation: 0, rotationX: 0, rotationY: 0,
      skewX: 0, skewY: 0, scaleX: 1, scaleY: 1, transformPerspective: 0, svg: isSvgChild(el), ox: 0, oy: 0, touched: false };
    try {
      if (cache.svg) {
        var base = el.transform && el.transform.baseVal;
        var mx = base && base.numberOfItems ? base.consolidate().matrix : null;
        // the computed CSS transform-origin counts as px offsets from the bbox corner (observed: "center center" in
        // a 400×300 viewBox resolves to 200px 150px and GSAP rotates about bbox.x + 200, bbox.y + 150)
        var co = "0px 0px";
        try { var cso = getComputedStyle(el).transformOrigin; if (cso) co = cso.split(" ").slice(0, 2).map(function (v) { return parseNum(v) + "px"; }).join(" "); } catch (e) { /* default */ }
        svgOriginFor(el, cache, co, false);
        if (mx) {
          decompose2d(mx.a, mx.b, mx.c, mx.d, mx.e, mx.f, cache);
          // matrix = T(x,y)·T(o)·RKS·T(-o): take the origin's share out of the translation
          var lin = linearPart(cache);
          cache.x = mx.e - cache.ox + (lin[0] * cache.ox + lin[2] * cache.oy);
          cache.y = mx.f - cache.oy + (lin[1] * cache.ox + lin[3] * cache.oy);
        }
      } else {
        var cs = getComputedStyle(el);
        var t = cs.transform;
        var m = readIndividual(cs);
        if (t && t !== "none") m.multiplySelf(new DOMMatrix(t));
        if (!m.isIdentity) {
          if (m.is2D) decompose2d(m.a, m.b, m.c, m.d, m.e, m.f, cache);
          else { decompose2d(m.m11, m.m12, m.m21, m.m22, m.m41, m.m42, cache); cache.z = m.m43; }
          // a translation of exactly -50 % of the box reads as xPercent/yPercent -50 (CSS centring), like GSAP
          // Observed rule (30 heights probed, oracle `centring.js`/`centring2.js`): -50 % when
          // round(offsetSize / 2) === round(-translation); the remainder (translation + offsetSize / 2) stays in x/y.
          // So a 100.45 px box centres, a 100.5 px one (offsetHeight 101) does not — x-post's card ends low in GSAP too.
          var w = el.offsetWidth, h = el.offsetHeight;
          if (cache.x && w && Math.round(w / 2) === Math.round(-cache.x)) { cache.x = cache.x + w / 2; cache.xPercent = -50; }
          if (cache.y && h && Math.round(h / 2) === Math.round(-cache.y)) { cache.y = cache.y + h / 2; cache.yPercent = -50; }
        }
      }
    } catch (e) { warn("could not read the transform of an element: " + e); }
    cache.x = r4(cache.x); cache.y = r4(cache.y);
    CACHE.set(el, cache);
    return cache;
  }
  function linearPart(c) {
    var rot = c.rotation / DEG, skx = c.skewX / DEG, sky = c.skewY / DEG;
    var cos = Math.cos(rot), sin = Math.sin(rot);
    // R · skew(skx, sky) · S
    var k11 = 1, k12 = Math.tan(skx), k21 = Math.tan(sky), k22 = 1;
    var r11 = cos * k11 - sin * k21, r12 = cos * k12 - sin * k22, r21 = sin * k11 + cos * k21, r22 = sin * k12 + cos * k22;
    return [r11 * c.scaleX, r21 * c.scaleX, r12 * c.scaleY, r22 * c.scaleY]; // a, b, c, d
  }
  function lenStr(v, u) { return r4(v) + (u || "px"); }
  function renderTransform(el, c) {
    if (!c.touched) {
      c.touched = true;
      try { el.style.translate = "none"; el.style.rotate = "none"; el.style.scale = "none"; } catch (e) { /* old engine */ }
      if (c.svg) el.style.transformOrigin = "0px 0px"; // the origin lives in the matrix (as GSAP does)
    }
    if (c.svg) {
      var lin = linearPart(c).map(r5); // GSAP computes e/f from the rounded matrix (observed)
      var bb = null;
      var tx = c.x, ty = c.y;
      if (c.xPercent || c.yPercent) {
        try { bb = el.getBBox(); } catch (e) { bb = { width: 0, height: 0 }; }
        tx += c.xPercent / 100 * bb.width; ty += c.yPercent / 100 * bb.height;
      }
      var e = tx + c.ox - (lin[0] * c.ox + lin[2] * c.oy);
      var f = ty + c.oy - (lin[1] * c.ox + lin[3] * c.oy);
      el.setAttribute("transform", "matrix(" + r5(lin[0]) + "," + r5(lin[1]) + "," + r5(lin[2]) + "," + r5(lin[3]) + "," + r4(e) + "," + r4(f) + ")");
      return;
    }
    // which parts to write is decided on the rounded values (GSAP omits scale(1, 1) for a scale of 0.99998)
    var s = "", xp = r4(c.xPercent), yp = r4(c.yPercent), x = r4(c.x), y = r4(c.y), z = r4(c.z), rot = r4(c.rotation);
    var ry = r4(c.rotationY), rx = r4(c.rotationX), skx = r5(c.skewX), sky = r5(c.skewY), sx = r4(c.scaleX), sy = r4(c.scaleY);
    if (c.transformPerspective) s += "perspective(" + r4(c.transformPerspective) + "px) ";
    if (xp || yp) s += "translate(" + xp + "%, " + yp + "%) ";
    if (z) s += "translate3d(" + x + (c.xu || "px") + ", " + y + (c.yu || "px") + ", " + z + "px) ";
    else if (x || y) s += "translate(" + x + (c.xu || "px") + ", " + y + (c.yu || "px") + ") ";
    if (rot) s += "rotate(" + rot + "deg) ";
    if (ry) s += "rotateY(" + ry + "deg) ";
    if (rx) s += "rotateX(" + rx + "deg) ";
    if (skx || sky) s += "skew(" + skx + "deg, " + sky + "deg) ";
    if (sx !== 1 || sy !== 1) s += "scale(" + sx + ", " + sy + ") ";
    el.style.transform = s ? s.slice(0, -1) : "translate(0px, 0px)";
  }
  var ORIGIN_WORDS = { left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" };
  function normOrigin(v) {
    var parts = String(v).trim().split(/\s+/);
    if (parts.length === 1) {
      var w = parts[0];
      if (w === "top" || w === "bottom") parts = ["center", w];
      else parts = [w, "center"];
    }
    if (parts[0] === "top" || parts[0] === "bottom" || parts[1] === "left" || parts[1] === "right") parts = [parts[1], parts[0]].concat(parts.slice(2));
    return parts.map(function (p, i) {
      if (ORIGIN_WORDS[p] !== undefined) return ORIGIN_WORDS[p];
      return i < 2 && /^-?[\d.]+$/.test(p) ? p + "px" : p;
    }).join(" ");
  }
  function angle(v, unitDefault) {
    if (isNum(v)) return v;
    var s = String(v).trim();
    var n = parseFloat(s.replace(/^[+\-*]=/, ""));
    if (/rad$/.test(s)) n *= DEG;
    else if (/turn$/.test(s)) n *= 360;
    return isNaN(n) ? 0 : n;
  }

  // ================================================================ property tweens
  // A prop tween knows one (target, key): its start, its end, and how to write a value for a ratio.
  var RESERVED = {
    duration: 1, ease: 1, delay: 1, repeat: 1, repeatDelay: 1, yoyo: 1, yoyoEase: 1, stagger: 1, onStart: 1,
    onStartParams: 1, onUpdate: 1, onUpdateParams: 1, onComplete: 1, onCompleteParams: 1, onRepeat: 1,
    onRepeatParams: 1, onReverseComplete: 1, onReverseCompleteParams: 1, onInterrupt: 1, onInterruptParams: 1,
    callbackScope: 1, immediateRender: 1, overwrite: 1, paused: 1, id: 1, data: 1, keyframes: 1, runBackwards: 1,
    startAt: 1, inherit: 1, lazy: 1, defaults: 1, reversed: 1, autoRound: 1, snap: 1, roundProps: 1, modifiers: 1,
    force3D: 1, smoothOrigin: 1, easeEach: 1, onFullfill: 1, parent: 1, callbacks: 1, autoRevert: 1, extendTimeline: 1,
    smoothChildTiming: 1, autoRemoveChildren: 1, repeatRefresh: 1, preventOverlaps: 1, fastScrollEnd: 1,
  };
  var UNITLESS = { opacity: 1, zIndex: 1, fontWeight: 1, flexGrow: 1, flexShrink: 1, order: 1, zoom: 1, strokeDashoffset: 1,
    strokeOpacity: 1, fillOpacity: 1, stopOpacity: 1, strokeMiterlimit: 1, columnCount: 1, orphans: 1, widows: 1,
    aspectRatio: 1, floodOpacity: 1, scale: 1 };
  var NO_ROUND = { opacity: 1, strokeDashoffset: 1, lineHeight: 1 };

  /** Resolve a vars value for one target: function-based values, "random(…)" strings. */
  function resolveValue(v, i, target, targets) {
    if (isFn(v)) v = v(i, target, targets);
    if (isStr(v) && v.indexOf("random(") === 0) {
      var inner = v.slice(7, -1).trim();
      if (inner[0] === "[") {
        var list = inner.slice(1, -1).split(",").map(function (s) { return s.trim(); });
        v = list[Math.floor(rand() * list.length)];
        var nv = parseFloat(v);
        if (!isNaN(nv) && String(nv) === v) v = nv;
      } else {
        var a = inner.split(",").map(parseFloat);
        v = utils.random(a[0], a[1], a[2]);
      }
    }
    return v;
  }
  /** Relative values: "+=10" / "-=10" / "*=2" applied to a numeric start. */
  function relative(endStr, start) {
    var m = isStr(endStr) && endStr.match(/^([+\-*/])=\s*(.*)$/);
    if (!m) return null;
    var n = parseFloat(m[2]);
    var u = getUnit(m[2]);
    var v = m[1] === "+" ? start + n : m[1] === "-" ? start - n : m[1] === "*" ? start * n : start / n;
    return { v: v, u: u };
  }

  function cssGet(el, prop) {
    if (prop.indexOf("--") === 0) {
      var cv = getComputedStyle(el).getPropertyValue(prop).trim();
      return cv || el.style.getPropertyValue(prop).trim();
    }
    var inline = el.style[prop];
    if (inline) return String(inline);
    var cs = getComputedStyle(el);
    var v = cs[prop];
    if (v === undefined || v === "") v = cs.getPropertyValue(kebab(prop));
    return v == null ? "" : String(v);
  }
  function cssSet(el, prop, value) {
    if (prop.indexOf("--") === 0) el.style.setProperty(prop, value);
    else if (prop in el.style) el.style[prop] = value;
    else el.style.setProperty(kebab(prop), value);
  }
  /** px per one `unit` of `prop` on `el` (for converting a computed px start into the end's unit). */
  function pxPerUnit(el, prop, unit) {
    if (unit === "px" || !unit) return 1;
    if (unit === "vw") return root.innerWidth / 100;
    if (unit === "vh") return root.innerHeight / 100;
    if (unit === "vmin") return Math.min(root.innerWidth, root.innerHeight) / 100;
    if (unit === "vmax") return Math.max(root.innerWidth, root.innerHeight) / 100;
    if (unit === "rem") return parseNum(getComputedStyle(document.documentElement).fontSize) || 16;
    if (unit === "em" && prop !== "fontSize") return parseNum(getComputedStyle(el).fontSize) || 16;
    if (unit === "em" && prop === "fontSize") return el.parentElement ? parseNum(getComputedStyle(el.parentElement).fontSize) || 16 : 16;
    var old = el.style[prop];
    try {
      el.style[prop] = "100" + unit;
      var px = parseNum(getComputedStyle(el)[prop]);
      return px / 100 || 1;
    } catch (e) { return 1; }
    finally { el.style[prop] = old; }
  }

  // kinds: "tf" transform component, "css", "attr", "prop" (object/DOM property), "plugin"
  function PropTween(target, key, kind) {
    this.t = target; this.key = key; this.kind = kind;
    this.mode = "num"; // num | color | complex | discrete
    this.s = 0; this.e = 0; this.u = ""; this.fn = null; this.round = false; this.snap = 0; this.mod = null;
    this.alive = true;
  }
  /** The value for a ratio, as it would be written (number for "num" on objects/transforms, string otherwise). */
  PropTween.prototype.value = function (r) {
    var v;
    if (this.mode === "num") {
      v = r === 1 ? this.e : r === 0 ? this.s : this.s + (this.e - this.s) * r;
      if (this.snap) v = Math.round(v / this.snap) * this.snap;
      return v;
    }
    if (this.mode === "discrete") {
      if (this.key === "display" && this.e === "none") return r >= 1 ? this.e : this.s;
      return r > 0 ? this.e : this.s;
    }
    return this.fn(r); // color/complex: fn(r) → string
  };
  PropTween.prototype.apply = function (r) {
    if (!this.alive) return;
    if (this.deadAt !== undefined && this.root && this.root._tTime >= this.deadAt - 1e-9) return; // overwrite "auto"
    var v = this.value(r);
    var t = this.t;
    switch (this.kind) {
      case "tf": {
        var c = getCache(t);
        c[this.key] = this.mode === "num" ? v : parseNum(v);
        if (this.mod) c[this.key] = this.mod(c[this.key], t);
        renderTransform(t, c);
        return;
      }
      case "css": {
        var out;
        if (this.mode === "num") {
          if (this.key === "zIndex") out = String(Math.round(v));
          else if (this.round) out = Math.round(v) + this.u;
          else out = r4(v) + this.u;
        } else out = v;
        if (this.mod) out = this.mod(out, t);
        cssSet(t, this.key, out);
        return;
      }
      case "attr": {
        var a = this.mode === "num" ? r4(v) + this.u : v;
        if (this.mod) a = this.mod(a, t);
        t.setAttribute(this.key, a);
        return;
      }
      case "prop": {
        var pv = this.mode === "num" ? (this.u ? r6(v) + this.u : this.isDom ? (this.snap ? v : r4(v)) : r6(v)) : v;
        if (this.mod) pv = this.mod(pv, t);
        if (this.setter) t[this.key](pv);
        else t[this.key] = pv;
        return;
      }
      case "plugin":
        this.plugin.render(this, r);
        return;
    }
  };

  /** Start value of (target, key) for a tween being initialised: from the previous tween on it, else the target. */
  function readStart(target, kind, key) {
    switch (kind) {
      case "tf": {
        var c = getCache(target);
        if (key === "x") return { v: c.x, u: c.xu };
        if (key === "y") return { v: c.y, u: c.yu };
        return { v: c[key] };
      }
      case "css": return { v: cssGet(target, key) };
      case "attr": { var a = target.getAttribute(key); return { v: a == null ? "0" : a }; }
      case "prop": return { v: isFn(target[key]) ? target[key]() : target[key] };
    }
    return { v: 0 };
  }

  /** Fill a PropTween's start/end from the raw start value and the vars' end value. */
  function setupProp(pt, startRaw, endRaw, vars) {
    var t = pt.t, key = pt.key, kind = pt.kind;
    var sv = startRaw.v, su = startRaw.u;
    if (kind === "tf") {
      if (key === "transformOrigin" || key === "svgOrigin") return false; // handled at init
      var isRot = /^rotation|^skew/.test(key);
      var startN = isNum(sv) ? sv : parseNum(sv);
      var rel = relative(endRaw, startN);
      var endN, endU = "";
      if (rel) { endN = isRot ? startN + (angle(String(endRaw).replace(/^[+\-*]=/, "")) * (String(endRaw)[0] === "-" ? -1 : 1)) : rel.v; endU = rel.u; }
      else if (isRot) endN = angle(endRaw);
      else { endN = parseNum(endRaw); endU = getUnit(endRaw); }
      if (isRot) endU = "";
      if ((key === "x" || key === "y") && endU && endU !== "px") {
        // keep the end's unit (translate(50%, 0px)); a px start converts through the box
        var size = key === "x" ? t.offsetWidth : t.offsetHeight;
        var per = endU === "%" ? (size || 1) / 100 : endU === "vw" ? root.innerWidth / 100 : endU === "vh" ? root.innerHeight / 100 :
          endU === "em" ? parseNum(getComputedStyle(t).fontSize) : endU === "rem" ? parseNum(getComputedStyle(document.documentElement).fontSize) : 1;
        if ((su || "px") === "px") startN = per ? startN / per : 0;
        pt.unitKey = endU;
        var c = getCache(t);
        c[key === "x" ? "xu" : "yu"] = endU;
      } else if (key === "x" || key === "y") {
        var c2 = getCache(t);
        if (c2[key === "x" ? "xu" : "yu"] !== "px" && !endU) { startN = 0; c2[key === "x" ? "xu" : "yu"] = "px"; }
      }
      pt.s = startN; pt.e = endN; pt.mode = "num";
      return true;
    }
    if (kind === "attr" || kind === "css" || kind === "prop") {
      if (isNum(endRaw) || (isStr(endRaw) && /^[+\-*/]=/.test(endRaw))) {
        var sN = isNum(sv) ? sv : parseNum(sv);
        var sUnit = isNum(sv) ? "" : getUnit(String(sv).trim());
        var rl = relative(endRaw, sN);
        var eN = rl ? rl.v : endRaw;
        var eU = rl && rl.u ? rl.u : (kind === "css" && !UNITLESS[key] && key.indexOf("--") !== 0 && !(key === "lineHeight" && !rl) ? (sUnit || "px") : sUnit);
        if (kind === "css" && (key === "lineHeight" || key.indexOf("--") === 0) && !rl) eU = isNum(endRaw) ? "" : eU;
        if (kind === "prop" && isNum(endRaw) && !rl) eU = isStr(sv) ? getUnit(sv) : "";
        pt.s = sN; pt.e = eN; pt.u = eU; pt.mode = "num";
        pt.round = kind === "css" && eU === "px" && !NO_ROUND[key] && key.indexOf("--") !== 0 && vars.autoRound !== false;
        if (kind === "prop" && pt.isDom && isStr(sv) && !isNaN(parseFloat(sv)) && String(parseFloat(sv)) === sv.trim()) { pt.u = ""; }
        return true;
      }
      var es = String(endRaw);
      var ss = sv == null ? "" : String(sv);
      var ec = parseColor(es.trim());
      if (ec) {
        var sc = parseColor(ss.trim()) || { c: [ec.c[0], ec.c[1], ec.c[2], 0], hsl: null };
        if (EMPTYISH.test(ss.trim())) sc = { c: [0, 0, 0, 0], hsl: null };
        pt.mode = "color";
        var spaces = kind === "css" && key.indexOf("--") !== 0;
        pt.fn = function (r) { return r === 1 && !ec.hsl ? rgbaStr(ec.c, spaces) : mixColor(sc, ec, r, spaces); };
        return true;
      }
      // numeric strings on objects become numbers ("5" → "15" gives 10)
      var en = parseFloat(es), sn = parseFloat(ss);
      if (kind === "prop" && !isNaN(en) && String(en) === es.trim() && (ss === "" || (!isNaN(sn) && String(sn) === ss.trim()) || isNum(sv))) {
        pt.s = isNum(sv) ? sv : isNaN(sn) ? 0 : sn; pt.e = en; pt.u = ""; pt.mode = "num";
        return true;
      }
      var eUnit = getUnit(es.trim());
      if (kind === "css" && eUnit && /^[-+]?[\d.]/.test(es.trim()) && !/\s/.test(es.trim())) {
        // "50%", "2em", "10vw": convert a px start into the end's unit
        var s0 = parseNum(ss);
        var sU = getUnit(ss.trim()) || "px";
        if (sU !== eUnit) s0 = sU === "px" ? s0 / pxPerUnit(t, key, eUnit) : 0;
        pt.s = s0; pt.e = parseFloat(es); pt.u = eUnit; pt.mode = "num";
        pt.round = eUnit === "px" && !NO_ROUND[key] && key.indexOf("--") !== 0 && vars.autoRound !== false;
        return true;
      }
      if (kind === "prop" && eUnit && !isNaN(en) && !/\s/.test(es.trim())) {
        pt.s = isNum(sv) ? sv : parseNum(ss); pt.e = en; pt.u = eUnit; pt.mode = "num";
        return true;
      }
      if (hasNumOrColor(es) && (hasNumOrColor(ss) || EMPTYISH.test(ss.trim()))) {
        pt.mode = "complex";
        var interp = complexInterp(ss, es, kind === "css" && key.indexOf("--") !== 0);
        pt.fn = interp;
        return true;
      }
      pt.mode = "discrete"; pt.s = ss; pt.e = es;
      return true;
    }
    return false;
  }

  // ================================================================ plugins registry (vars keys handled by a plugin)
  var PLUGINS = {};

  // ================================================================ Animation base
  var _idCounter = 0;
  function Animation(vars) {
    this.vars = vars || {};
    this.parent = null;
    this._start = 0;
    this._delay = +this.vars.delay || 0;
    this._dur = 0;
    this._repeat = this.vars.repeat === -1 ? -1 : Math.max(0, Math.floor(+this.vars.repeat || 0));
    this._rDelay = +this.vars.repeatDelay || 0;
    this._yoyo = !!this.vars.yoyo;
    this._ts = 1;
    this._paused = !!this.vars.paused;
    this._tTime = 0;
    this._time = 0;
    this._iter = 0;
    this._rendered = false;
    this._killed = false;
    this._reversed = !!this.vars.reversed;
    this.data = this.vars.data;
    this._uid = ++_idCounter;
    if (this.vars.id != null) BY_ID[this.vars.id] = this;
  }
  var BY_ID = {};
  var A = Animation.prototype;
  A.totalDuration = function (v) {
    if (arguments.length) { var d = this.duration(); var reps = this._repeat < 0 ? 0 : this._repeat; this.duration((v - reps * this._rDelay) / (reps + 1) || 0); return this; }
    var dur = this.duration();
    if (this._repeat < 0) return BIG;
    return dur * (this._repeat + 1) + this._rDelay * this._repeat;
  };
  A.duration = function (v) {
    if (arguments.length) { this._dur = Math.max(0, +v || 0); this._dirtyUp(); return this; }
    return this._dur;
  };
  A._dirtyUp = function () { var p = this.parent; while (p) { p._dirty = true; p = p.parent; } };
  A.startTime = function (v) {
    if (arguments.length) { this._start = +v || 0; if (this.parent) { this.parent._sortChildren(); this._dirtyUp(); } return this; }
    return this._start;
  };
  A.endTime = function () { return this._start + this.totalDuration() / this._ts; };
  A.delay = function (v) {
    if (arguments.length) { this._start += (+v || 0) - this._delay; this._delay = +v || 0; if (this.parent) this.parent._sortChildren(); this._dirtyUp(); return this; }
    return this._delay;
  };
  A.timeScale = function (v) {
    if (arguments.length) { this._ts = +v || 1e-8; this._dirtyUp(); return this; }
    return this._ts;
  };
  A.repeat = function (v) { if (arguments.length) { this._repeat = v === -1 ? -1 : Math.max(0, Math.floor(+v || 0)); this._dirtyUp(); return this; } return this._repeat; };
  A.repeatDelay = function (v) { if (arguments.length) { this._rDelay = +v || 0; this._dirtyUp(); return this; } return this._rDelay; };
  A.yoyo = function (v) { if (arguments.length) { this._yoyo = !!v; return this; } return this._yoyo; };
  A.paused = function (v) { if (arguments.length) { this._paused = !!v; return this; } return this._paused; };
  A.pause = function (atTime, suppress) { this._paused = true; if (atTime != null) this.seek(atTime, suppress); return this; };
  A.play = function (from, suppress) { this._paused = false; this._reversed = false; if (from != null) this.seek(from, suppress); return this; };
  A.resume = function () { this._paused = false; return this; };
  A.reverse = function (from, suppress) { this._reversed = true; if (from != null) this.seek(from, suppress); return this; };
  A.reversed = function (v) { if (arguments.length) { this._reversed = !!v; return this; } return this._reversed; };
  A.restart = function (includeDelay, suppress) { this._paused = false; this.totalTime(0, suppress !== false); return this; };
  A.isActive = function () { return !this._paused && this._tTime > 0 && this._tTime < this.totalDuration(); };
  A.iteration = function (v) { if (arguments.length) { this.totalTime(v * (this._dur + this._rDelay), false); return this; } return this._iter + 1; };
  A.time = function (v, suppress) {
    if (!arguments.length) return this._time;
    var cycle = this._dur + this._rDelay;
    var base = this._repeat ? this._iter * cycle : 0;
    var t = +v || 0;
    if (this._yoyo && (this._iter & 1)) t = this._dur - t;
    return this.totalTime(base + Math.min(t, this._dur), suppress);
  };
  A.totalTime = function (v, suppress) {
    if (!arguments.length) return this._tTime;
    seekRoot(this, +v || 0, !!suppress);
    return this;
  };
  A.progress = function (v, suppress) {
    if (!arguments.length) return this._dur ? clamp(0, 1, this._time / this._dur) : this._done || this._tTime > 0 ? 1 : 0;
    return this.time((+v || 0) * this._dur, suppress);
  };
  A.totalProgress = function (v, suppress) {
    var td = this.totalDuration();
    if (!arguments.length) return td ? clamp(0, 1, this._tTime / td) : this._tTime > 0 ? 1 : 0;
    return this.totalTime((+v || 0) * td, suppress);
  };
  A.seek = function (pos, suppress) {
    var t = isStr(pos) && this._labelTime ? this._labelTime(pos) : +pos || 0;
    return this.totalTime(t, suppress !== false);
  };
  A.kill = function () {
    this._killed = true;
    if (this.parent) this.parent.remove(this);
    unregisterAnim(this);
    return this;
  };
  A.revert = function () { this.totalTime(0, true); this.kill(); return this; };
  A.eventCallback = function (type, fn, params) {
    if (arguments.length < 2) return this.vars[type];
    if (fn == null) delete this.vars[type];
    else { this.vars[type] = fn; if (params) this.vars[type + "Params"] = params; }
    return this;
  };
  A.then = function (onFulfilled) {
    var self = this;
    return new Promise(function (resolve) {
      var prev = self.vars.onComplete;
      self.vars.onComplete = function () { if (prev) prev.apply(this, arguments); self.vars.onComplete = prev; resolve(self); };
    }).then(onFulfilled);
  };
  A.globalTime = function (t) { var a = this, v = t; while (a) { v = a._start + v / a._ts; a = a.parent; } return v; };
  A._fire = function (type) {
    var fn = this.vars[type];
    if (!fn) return;
    try { fn.apply(this.vars.callbackScope || this, this.vars[type + "Params"] || []); }
    catch (e) { warn(type + " threw: " + (e && e.stack || e)); throw e; }
  };
  A._root = function () { var a = this; while (a.parent && !a.parent._isGlobal) a = a.parent; return a; };

  /** Iteration-local time for a clamped total time. */
  function iterTime(anim, tt) {
    var total = anim.totalDuration();
    var dur = anim._dur;
    if (tt <= 0) return { time: 0, iter: 0 };
    if (!anim._repeat) return { time: Math.min(tt, dur), iter: 0 };
    var cycle = dur + anim._rDelay;
    if (cycle <= 0) return { time: dur, iter: 0 };
    var iter = Math.floor(tt / cycle);
    var time = tt - iter * cycle;
    if (anim._repeat > 0 && iter > anim._repeat) { iter = anim._repeat; time = dur; }
    if (anim._repeat > 0 && tt >= total) { iter = anim._repeat; time = dur; }
    if (time > dur) time = dur;
    if (anim._yoyo && (iter & 1)) time = dur - time;
    return { time: time, iter: iter };
  }

  // ================================================================ Tween
  function Tween(targets, vars, parentDefaults) {
    var v = assign({}, GLOBAL_DEFAULTS, parentDefaults, vars);
    if (vars && vars.inherit === false) v = assign({}, GLOBAL_DEFAULTS, vars);
    Animation.call(this, v);
    this._targets = uniqueTargets(targets);
    this._targetsRaw = targets;
    this._dur = Math.max(0, +v.duration || 0);
    this._ease = parseEase(v.ease);
    this._props = null; // PropTweens after init
    this._initted = false;
    this._subs = null; // stagger / keyframe children (Tweens)
    this._done = false; // zero-duration state
    this._zL = undefined;
    this.ratio = 0;
    if (!this._targets.length && isStr(targets)) warn('no element matches "' + targets + '"');
    registerAnim(this);
  }
  var T = Tween.prototype = Object.create(A);
  T.constructor = Tween;
  T.targets = function () { return this._targets.slice(); };
  T.duration = function (v) {
    if (arguments.length) {
      if (this._subs) return this; // stagger groups keep their computed length
      this._dur = Math.max(0, +v || 0); this._dirtyUp(); return this;
    }
    return this._dur;
  };
  T.invalidate = function () {
    this._initted = false; this._props = null;
    if (this._subs) this._subs.forEach(function (s) { s.invalidate(); });
    var r = this._root(); r._chainDirty = true;
    return this;
  };

  /** Build this tween's prop tweens. `startOf(target, kind, key)` gives a start ({v,u}) or null to read the target. */
  T._init = function (startOf) {
    if (this._subs) { this._initted = true; return; }
    var vars = this.vars;
    var props = [];
    var self = this;
    var targets = this._list ? [this._targets[0]] : this._targets;
    var fromVars = this._fromVars; // from()/fromTo() start values
    var keys = Object.keys(vars).filter(function (k) { return !RESERVED[k] && !(self._fromMode && k in GLOBAL_DEFAULTS && vars[k] !== CURRENT); });
    if (vars.startAt) Object.keys(vars.startAt).forEach(function (k) { if (keys.indexOf(k) < 0 && !RESERVED[k]) keys.push(k); });
    var snapCfg = parseSnap(vars.snap, vars.roundProps);
    targets.forEach(function (target, ti) {
      // function-based values see the index in the whole staggered list
      var i = self._list ? self._indexInList : ti;
      var all = self._list || targets;
      var el = isEl(target);
      keys.forEach(function (k) {
        var endRaw = vars[k];
        if (k in PLUGINS && !(el && k === "text" && !root.TextPlugin)) {
          var pl = new PropTween(target, k, "plugin");
          pl.plugin = PLUGINS[k];
          var fromP = fromVars && fromVars[k] !== undefined ? resolveValue(fromVars[k], i, target, all) : undefined;
          if (pl.plugin.init(pl, resolveValue(endRaw, i, target, all), self, i, all, fromP) !== false) props.push(pl);
          return;
        }
        if (el && k === "attr" && isObj(endRaw)) {
          Object.keys(endRaw).forEach(function (ak) {
            var pt = new PropTween(target, ak, "attr");
            var e = resolveValue(endRaw[ak], i, target, all);
            var fs = fromVars && fromVars.attr && fromVars.attr[ak] !== undefined ? { v: resolveValue(fromVars.attr[ak], i, target, all) } : null;
            setupProp(pt, fs || startOf(target, "attr", ak) || readStart(target, "attr", ak), e, vars);
            props.push(pt);
          });
          return;
        }
        if (el && k === "css" && isObj(endRaw)) {
          Object.keys(endRaw).forEach(function (ck) { addProp(target, ck, endRaw[ck], i, all); });
          return;
        }
        addProp(target, k, endRaw, i, all);
      });
    });
    function addProp(target, k, endRaw, i, all) {
      var el = isEl(target);
      var startAtVal = vars.startAt && vars.startAt[k] !== undefined ? resolveValue(vars.startAt[k], i, target, all) : undefined;
      var e = endRaw === undefined && startAtVal !== undefined ? startAtVal : resolveValue(endRaw, i, target, all);
      var fromV = fromVars && fromVars[k] !== undefined ? resolveValue(fromVars[k], i, target, all) : startAtVal;
      if (el && (k === "transformOrigin" || k === "svgOrigin")) {
        // origins are set, not tweened (GSAP normalises keywords to percentages)
        var c = getCache(target);
        if (c.svg) svgOriginFor(target, c, e === CURRENT ? "0px 0px" : e, k === "svgOrigin");
        else if (e !== CURRENT) target.style.transformOrigin = normOrigin(e);
        props.push(originTween(target));
        return;
      }
      if (el && k === "autoAlpha") {
        var op = new PropTween(target, "opacity", "css");
        setupProp(op, fromV !== undefined ? { v: fromV } : startOf(target, "css", "opacity") || readStart(target, "css", "opacity"), e, vars);
        props.push(op);
        var vis = new PropTween(target, "visibility", "plugin");
        vis.plugin = AUTOALPHA_VIS; vis.op = op;
        props.push(vis);
        return;
      }
      if (el && TRANSFORM_KEYS[k]) {
        var tk = TRANSFORM_KEYS[k];
        if ((tk === "scaleX" || tk === "scaleY") && vars.scale !== undefined) return; // scale wins (observed)
        (tk === "scale" ? ["scaleX", "scaleY"] : [tk]).forEach(function (comp) {
          var pt = new PropTween(target, comp, "tf");
          var start;
          if (fromV !== undefined) {
            var fu = getUnit(fromV);
            start = { v: isRotKey(comp) ? angle(fromV) : parseNum(fromV), u: fu || undefined };
            if ((comp === "x" || comp === "y") && fu && fu !== "px") { getCache(target)[comp === "x" ? "xu" : "yu"] = fu; pt.unitKey = fu; }
          } else start = startOf(target, "tf", comp) || readStart(target, "tf", comp);
          setupProp(pt, start, e, vars);
          if (snapCfg && (snapCfg.all || snapCfg[k] !== undefined)) pt.snap = snapCfg.all ? 1 : snapCfg[k];
          if (vars.modifiers && isFn(vars.modifiers[k])) pt.mod = vars.modifiers[k];
          props.push(pt);
        });
        return;
      }
      var kind = !el ? "prop" : k.indexOf("--") === 0 || k in target.style || kebab(k) in target.style ? "css" : k in target ? "prop" : "css";
      var pt2 = new PropTween(target, k, kind);
      if (kind === "prop") {
        pt2.isDom = el;
        if (!el && isFn(target[k])) pt2.setter = true;
      }
      var st = fromV !== undefined ? { v: fromV } : startOf(target, kind, k) || readStart(target, kind, k);
      setupProp(pt2, st, e, vars);
      if (snapCfg && (snapCfg.all || snapCfg[k] !== undefined)) pt2.snap = snapCfg.all ? 1 : snapCfg[k];
      if (vars.modifiers && isFn(vars.modifiers[k])) pt2.mod = vars.modifiers[k];
      props.push(pt2);
    }
    this._props = props;
    this._initted = true;
  };
  function isRotKey(k) { return /^rotation|^skew/.test(k); }
  function originTween(target) {
    var pt = new PropTween(target, "transformOrigin", "plugin");
    pt.plugin = { render: function () { var c = getCache(target); if (c.svg) renderTransform(target, c); } };
    return pt;
  }
  var AUTOALPHA_VIS = {
    render: function (pt, r) {
      var o = pt.op.value(r);
      pt.t.style.visibility = (isNum(o) ? o : parseNum(o)) === 0 ? "hidden" : "inherit";
    },
  };
  function parseSnap(snap, roundProps) {
    var out = null;
    if (isStr(roundProps)) { out = {}; roundProps.split(",").forEach(function (k) { out[k.trim()] = 1; }); }
    if (snap == null) return out;
    out = out || {};
    if (isNum(snap)) { out.all = true; return out; }
    if (isStr(snap)) { snap.split(",").forEach(function (k) { out[k.trim()] = 1; }); return out; }
    if (isObj(snap)) Object.keys(snap).forEach(function (k) { out[k] = isNum(snap[k]) ? snap[k] : 1; });
    return out;
  }

  /** Apply this tween's values for an eased ratio. */
  T._apply = function (ratio) {
    this.ratio = ratio;
    var props = this._props;
    if (!props) return;
    for (var i = 0; i < props.length; i++) props[i].apply(ratio);
  };

  /** Value of one prop at a root-local time (for the canonical start of a later tween on the same property). */
  T._valueAtRoot = function (pt, rootTime) {
    var tt = localFromRoot(this, rootTime);
    if (!this._dur) return pt.value(tt >= 0 ? 1 : 0);
    var total = this.totalDuration();
    var it = iterTime(this, clamp(0, total, tt));
    return pt.value(this._ease(it.time / this._dur));
  };

  /**
   * Render at total time `tt` (this tween's local time; may be negative or past the end). `prevHint` is this tween's
   * previous local time as its parent last saw it (used the first time a zero-duration tween is reached).
   */
  T.render = function (tt, suppress, force, prevHint) {
    if (this._killed) return;
    if (!this._initted) initRootChain(this._root());
    if (!this._initted) this._init(function () { return null; });
    if (this._subs) return this._renderGroup(tt, suppress, force);
    if (!this._dur) return this._renderZero(tt, suppress, force, prevHint);
    var total = this.totalDuration();
    var ctt = tt < 0 ? 0 : tt > total ? total : tt;
    if (ctt === this._tTime && !force && (this._rendered || ctt === 0)) return;
    var prevTT = this._tTime;
    var prevIter = this._iter;
    var it = iterTime(this, ctt);
    this._tTime = ctt; this._time = it.time; this._iter = it.iter; this._rendered = true;
    this._apply(this._ease(it.time / this._dur));
    if (suppress) return;
    if (prevTT === 0 && ctt > 0) this._fire("onStart");
    this._fire("onUpdate");
    if (it.iter !== prevIter) this._fire("onRepeat");
    if (ctt === total && prevTT < total) this._fire("onComplete");
    else if (ctt === 0 && prevTT > 0) this._fire("onReverseComplete");
  };
  T._renderZero = function (L, suppress, force, prevHint) {
    var prevL = this._zL === undefined ? prevHint : this._zL;
    var done = this._done;
    var nd = done;
    if (L > 0) nd = true;
    else if (L < 0) nd = false;
    else if (prevL !== undefined && prevL < 0) nd = true;
    else if (prevL !== undefined && prevL > 0) nd = false;
    this._zL = L;
    if (nd === done && !force) return;
    this._done = nd;
    this._tTime = 0; this._time = 0; this._rendered = true;
    this._apply(nd ? 1 : 0);
    if (suppress || nd === done) return;
    if (!nd && prevL === 0) return; // leaving exactly-at backwards: values revert, no callback (observed)
    if (nd) this._fire("onComplete");
    else this._fire("onReverseComplete");
  };
  /** Stagger / keyframe groups: subs rendered like a timeline over this tween's local time. */
  T._renderGroup = function (tt, suppress, force) {
    var total = this.totalDuration();
    var ctt = tt < 0 ? 0 : tt > total ? total : tt;
    if (ctt === this._tTime && !force && (this._rendered || ctt === 0)) return;
    var prevTT = this._tTime, prevIter = this._iter;
    var prevTime = this._time;
    var it = iterTime(this, ctt);
    var time = this._warp ? this._warp(it.time) : it.time;
    var prevLocal = this._warp && this._rendered ? this._warp(prevTime) : prevTime;
    this._tTime = ctt; this._time = it.time; this._iter = it.iter; this._rendered = true;
    renderChildren(this._subs, time, suppress, force, this._rendered ? prevLocal : 0);
    this.ratio = this._dur ? it.time / this._dur : 1;
    if (suppress) return;
    if (prevTT === 0 && ctt > 0) this._fire("onStart");
    this._fire("onUpdate");
    if (it.iter !== prevIter) this._fire("onRepeat");
    if (ctt === total && prevTT < total) this._fire("onComplete");
    else if (ctt === 0 && prevTT > 0) this._fire("onReverseComplete");
  };

  /** Render a sorted child list at local time `time` (pass 1: revert children ahead of it, last first; pass 2: the rest in order). */
  function renderChildren(children, time, suppress, force, prevTime) {
    var i, ch;
    for (i = children.length - 1; i >= 0; i--) {
      ch = children[i];
      if (ch._start > time && !ch._paused && advanced(ch)) ch.render((time - ch._start) * ch._ts, suppress, force, (prevTime - ch._start) * ch._ts);
    }
    for (i = 0; i < children.length; i++) {
      ch = children[i];
      // a child the playhead has just reached renders even at exactly its start (observed: a fromTo at 9 s puts its
      // start state back over an earlier set() when the parent arrives at 9 s)
      if (ch._start <= time && !ch._paused) ch.render((time - ch._start) * ch._ts, suppress, force || ch._start > prevTime, (prevTime - ch._start) * ch._ts);
    }
  }
  function advanced(a) {
    if (a instanceof Tween && !a._subs && !a._dur) return a._done;
    return a._tTime > 0;
  }

  // ================================================================ Timeline
  function Timeline(vars, parentDefaults) {
    var v = assign({}, vars || {});
    Animation.call(this, v);
    this._children = [];
    this.labels = {};
    this._recent = null;
    this._dirty = false;
    this._chainDirty = true;
    this._defaults = assign({}, parentDefaults, v.defaults);
    this._isGlobal = false;
  }
  var TL = Timeline.prototype = Object.create(A);
  TL.constructor = Timeline;
  TL.duration = function (v) {
    if (arguments.length) {
      var cur = this.duration();
      if (cur && v !== cur) this.timeScale(this._ts * cur / (+v || 1e-8));
      return this;
    }
    if (this._dirty) {
      var max = 0;
      for (var i = 0; i < this._children.length; i++) {
        var c = this._children[i];
        var end = c._start + (c._repeat < 0 ? c.duration() : c.totalDuration()) / c._ts;
        if (end > max) max = end;
      }
      this._dur = max;
      this._dirty = false;
    }
    return this._dur;
  };
  TL._sortChildren = function () {
    this._children.sort(function (a, b) { return a._start - b._start || a._order - b._order; });
  };
  var _orderCounter = 0;
  TL._insert = function (child, position) {
    if (child.parent) child.parent.remove(child);
    var start = this._parsePosition(position, child) + child._delay;
    child._start = start;
    child.parent = this;
    child._order = ++_orderCounter;
    this._children.push(child);
    this._sortChildren();
    this._recent = child;
    this._dirty = true;
    this._dirtyUp();
    this._root()._chainDirty = true;
    return child;
  };
  TL.remove = function (child) {
    if (Array.isArray(child)) { var self = this; child.forEach(function (c) { self.remove(c); }); return this; }
    if (isStr(child)) return this.removeLabel(child);
    if (isFn(child)) { var kill = this._children.filter(function (c) { return c._callFn === child; }); this.remove(kill); return this; }
    var i = this._children.indexOf(child);
    if (i >= 0) {
      this._children.splice(i, 1);
      child.parent = null;
      if (this._recent === child) this._recent = this._children[this._children.length - 1] || null;
      this._dirty = true;
      this._dirtyUp();
    }
    return this;
  };
  TL._labelTime = function (s) {
    var m = String(s).match(/^([^+\-=]+?)\s*(?:([+\-])=\s*([\d.]+))?$/);
    if (m && this.labels[m[1]] !== undefined) return this.labels[m[1]] + (m[2] ? (m[2] === "+" ? 1 : -1) * parseFloat(m[3]) : 0);
    return parseFloat(s) || 0;
  };
  /** The position parameter (observed semantics, see STATUS.md). */
  TL._parsePosition = function (pos, child) { return rt(this._parsePos(pos, child)); };
  function rt(v) { return Math.round(v * 1e8) / 1e8; }
  TL._parsePos = function (pos, child) {
    var end = this.duration();
    var recent = this._recent;
    var childDur = child ? child.totalDuration() / child._ts : 0;
    if (pos == null || pos === "") return end;
    if (isNum(pos)) return pos;
    var s = String(pos).trim();
    if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(s)) return parseFloat(s);
    var m;
    if ((m = s.match(/^([<>])\s*(?:([+\-]=?)\s*)?([\d.]+)?\s*(%)?$/))) {
      var base = recent ? (m[1] === "<" ? recent._start : recent.endTime()) : (m[1] === "<" ? 0 : end);
      if (!m[3]) return base;
      var sign = m[2] && m[2][0] === "-" ? -1 : 1;
      var amt = parseFloat(m[3]);
      if (m[4]) amt = amt / 100 * (recent ? recent.totalDuration() / recent._ts : 0);
      return base + sign * amt;
    }
    if ((m = s.match(/^([+\-])=\s*([\d.]+)\s*(%)?$/))) {
      var a = parseFloat(m[2]);
      if (m[3]) a = a / 100 * childDur;
      return end + (m[1] === "+" ? a : -a);
    }
    if ((m = s.match(/^(.+?)\s*([+\-])=\s*([\d.]+)\s*(%)?$/))) {
      if (this.labels[m[1]] === undefined) this.labels[m[1]] = end;
      var b = parseFloat(m[3]);
      if (m[4]) b = b / 100 * childDur;
      return this.labels[m[1]] + (m[2] === "+" ? b : -b);
    }
    if (this.labels[s] === undefined) this.labels[s] = end;
    return this.labels[s];
  };
  TL._childDefaults = function () { return this._defaults; };
  function normVars(vars, maybeVars) {
    // legacy to(targets, duration, vars)
    if (isNum(vars)) return assign({}, maybeVars, { duration: vars });
    return vars || {};
  }
  TL.to = function (targets, vars, position, pos2) {
    if (isNum(vars)) { var v = normVars(vars, position); position = pos2; vars = v; }
    var tw = createTween(targets, vars, this._childDefaults(), "to");
    this._insert(tw, position);
    afterInsert(tw); // only when immediateRender: true
    return this;
  };
  TL.from = function (targets, vars, position, pos2) {
    if (isNum(vars)) { var v = normVars(vars, position); position = pos2; vars = v; }
    var tw = createTween(targets, vars, this._childDefaults(), "from");
    this._insert(tw, position);
    afterInsert(tw);
    return this;
  };
  TL.fromTo = function (targets, fromVars, toVars, position, pos2) {
    if (isNum(fromVars)) { var d = fromVars; fromVars = toVars; toVars = assign({}, position, { duration: d }); position = pos2; }
    var tw = createTween(targets, toVars, this._childDefaults(), "fromTo", fromVars);
    this._insert(tw, position);
    afterInsert(tw);
    return this;
  };
  TL.set = function (targets, vars, position) {
    var v = assign({}, vars, { duration: 0 });
    if (v.immediateRender === undefined) v.immediateRender = false;
    var tw = createTween(targets, v, this._childDefaults(), "set");
    this._insert(tw, position);
    afterInsert(tw);
    return this;
  };
  TL.call = function (fn, params, position) {
    if (!isFn(fn)) return this;
    if (!Array.isArray(params) && params != null && position === undefined) { position = params; params = null; }
    var tw = makeCall(fn, params);
    this._insert(tw, position);
    return this;
  };
  TL.add = function (child, position) {
    if (child == null) return this;
    if (isStr(child)) return this.addLabel(child, position);
    if (isFn(child)) return this.call(child, null, position);
    if (Array.isArray(child)) {
      var at = this._parsePosition(position, null);
      var self = this;
      child.forEach(function (c) { self.add(c, at); });
      return this;
    }
    if (child instanceof Animation) { this._insert(child, position); return this; }
    return this;
  };
  TL.addLabel = function (name, position) { this.labels[name] = this._parsePosition(position, null); return this; };
  TL.removeLabel = function (name) { delete this.labels[name]; return this; };
  TL.addPause = function (position, cb, params) { if (cb) this.call(cb, params, position); return this; };
  TL.getChildren = function (nested, tweens, timelines, ignoreBefore) {
    nested = nested !== false; tweens = tweens !== false; timelines = timelines !== false;
    var out = [];
    this._children.forEach(function (c) {
      if (ignoreBefore != null && c._start < ignoreBefore) return;
      if (c instanceof Timeline) {
        if (timelines) out.push(c);
        if (nested) out.push.apply(out, c.getChildren(true, tweens, timelines));
      } else if (tweens) out.push(c);
    });
    return out;
  };
  TL.getTweensOf = function (targets, onlyActive) {
    var list = uniqueTargets(targets);
    return this.getChildren(true, true, false).filter(function (tw) {
      return tw._targets && tw._targets.some(function (t) { return list.indexOf(t) >= 0; }) && (!onlyActive || tw.isActive());
    });
  };
  TL.getById = function (id) { var c = this.getChildren(true, true, true).filter(function (a) { return a.vars.id === id; }); return c[0]; };
  TL.recent = function () { return this._recent; };
  TL.clear = function (labels) {
    var self = this;
    this._children.slice().forEach(function (c) { self.remove(c); });
    if (labels !== false) this.labels = {};
    this._recent = null;
    this._chainDirty = true;
    return this;
  };
  TL.killTweensOf = function (targets) { this.getTweensOf(targets).forEach(function (t) { t.kill(); }); return this; };
  TL.invalidate = function () {
    this._children.forEach(function (c) { c.invalidate(); });
    this._root()._chainDirty = true;
    return this;
  };
  TL.shiftChildren = function (amount, adjustLabels, ignoreBefore) {
    ignoreBefore = ignoreBefore || 0;
    this._children.forEach(function (c) { if (c._start >= ignoreBefore) c._start += amount; });
    if (adjustLabels) for (var k in this.labels) if (this.labels[k] >= ignoreBefore) this.labels[k] += amount;
    this._sortChildren(); this._dirty = true; this._dirtyUp(); this._root()._chainDirty = true;
    return this;
  };
  TL.currentLabel = function () {
    var best = null, bt = -Infinity, t = this._time;
    for (var k in this.labels) if (this.labels[k] <= t && this.labels[k] > bt) { bt = this.labels[k]; best = k; }
    return best;
  };
  TL.nextLabel = function (t) {
    t = t == null ? this._time : t;
    var best = null, bt = Infinity;
    for (var k in this.labels) if (this.labels[k] > t && this.labels[k] < bt) { bt = this.labels[k]; best = k; }
    return best;
  };
  TL.previousLabel = function (t) {
    t = t == null ? this._time : t;
    var best = null, bt = -Infinity;
    for (var k in this.labels) if (this.labels[k] < t && this.labels[k] > bt) { bt = this.labels[k]; best = k; }
    return best;
  };
  TL.tweenTo = function (position, vars) {
    var self = this;
    var to = isStr(position) ? this._labelTime(position) : +position || 0;
    return createTween(this, assign({ time: to, duration: Math.abs(to - this._time) || 0.001, ease: "none" }, vars), {}, "to");
  };
  TL.tweenFromTo = function (from, to, vars) {
    var f = isStr(from) ? this._labelTime(from) : +from || 0;
    var t = isStr(to) ? this._labelTime(to) : +to || 0;
    return createTween(this, assign({ time: t, duration: Math.abs(t - f) || 0.001, ease: "none" }, vars), {}, "fromTo", { time: f });
  };
  TL.render = function (tt, suppress, force) {
    if (this._killed) return;
    if (this._chainDirty && !this._isGlobal && this._root() === this) initRootChain(this);
    var total = this.totalDuration();
    var ctt = tt < 0 ? 0 : tt > total ? total : tt;
    if (ctt === this._tTime && !force && (this._rendered || ctt === 0)) return;
    var prevTT = this._tTime, prevIter = this._iter, prevTime = this._time;
    var it = iterTime(this, ctt);
    this._tTime = ctt; this._time = it.time; this._iter = it.iter;
    var wasRendered = this._rendered;
    this._rendered = true;
    if (!suppress && prevTT === 0 && ctt > 0) this._fire("onStart");
    var prevLocal = wasRendered ? prevTime : 0;
    if (it.iter !== prevIter && wasRendered) prevLocal = this._yoyo && (it.iter & 1) ? this._dur : 0;
    renderChildren(this._children, it.time, suppress, force, prevLocal);
    if (suppress) return;
    this._fire("onUpdate");
    if (it.iter !== prevIter) this._fire("onRepeat");
    if (ctt === total && prevTT < total) this._fire("onComplete");
    else if (ctt === 0 && prevTT > 0) this._fire("onReverseComplete");
  };
  // timeline rendering from the public API goes through seekRoot()

  // ================================================================ creating tweens (stagger, keyframes, from)
  var GLOBAL_DEFAULTS = { duration: 0.5, ease: "power1.out" };

  function createTween(targets, vars, parentDefaults, type, fromVars) {
    vars = vars || {};
    var merged = assign({}, parentDefaults, vars);
    if (vars.inherit === false) merged = assign({}, vars);
    var list = uniqueTargets(targets);
    var tw;
    if (merged.keyframes) tw = keyframeTween(targets, merged, parentDefaults, type, fromVars);
    else if (merged.stagger != null && list.length > 1) tw = staggerTween(list, merged, parentDefaults, type, fromVars, targets);
    else {
      tw = new Tween(targets, vars, parentDefaults);
      setupFrom(tw, type, fromVars);
    }
    tw._type = type;
    if (merged.overwrite === true) overwriteAll(tw);
    tw._overwriteAuto = merged.overwrite === "auto";
    return tw;
  }
  function setupFrom(tw, type, fromVars) {
    if (type === "from") {
      // the vars hold the START; the end is whatever the target is at init
      var fv = {};
      Object.keys(tw.vars).forEach(function (k) { if (!RESERVED[k] && !(k in GLOBAL_DEFAULTS)) fv[k] = tw.vars[k]; });
      tw._fromVars = fv;
      tw._fromMode = true;
      tw._immediate = tw.vars.immediateRender !== false;
    } else if (type === "fromTo") {
      tw._fromVars = fromVars || {};
      tw._immediate = (tw.vars.immediateRender !== undefined ? tw.vars.immediateRender : fromVars && fromVars.immediateRender) !== false;
    } else if (type === "set") {
      tw._immediate = tw.vars.immediateRender === true;
    } else {
      tw._immediate = tw.vars.immediateRender === true;
    }
  }
  /** from(): swap so the vars are the start and the target's current values the end. */
  var _baseInit = T._init;
  T._init = function (startOf) {
    if (!this._fromMode) return _baseInit.call(this, startOf);
    // build "to current" props, then use the from vars as starts
    var vars = this.vars;
    var keys = Object.keys(this._fromVars);
    var endVars = {};
    var self = this;
    // current values become the end: a to() towards the present state, starting at the from values
    keys.forEach(function (k) { endVars[k] = k === "attr" ? {} : undefined; });
    var proxy = Object.create(vars);
    keys.forEach(function (k) {
      if (k === "attr" && isObj(self._fromVars.attr)) {
        var o = {};
        Object.keys(self._fromVars.attr).forEach(function (ak) { o[ak] = function (i, t) { var a = t.getAttribute(ak); return a == null ? 0 : a; }; });
        proxy.attr = o;
      } else proxy[k] = CURRENT;
    });
    var saveVars = this.vars;
    this.vars = proxy;
    var fv = this._fromVars;
    this._fromVars = fv;
    _baseInit.call(this, function (target, kind, key) { return startOf(target, kind, key); });
    this.vars = saveVars;
  };
  // CURRENT: "the value the target has now" as an end value (from() tweens)
  var CURRENT = { __current: true };
  var _setupProp = setupProp;
  setupProp = function (pt, startRaw, endRaw, vars) {
    if (endRaw === CURRENT) {
      var now = readStart(pt.t, pt.kind, pt.key);
      return _setupProp(pt, startRaw, now.u && now.u !== "px" ? now.v + now.u : now.v, vars);
    }
    return _setupProp(pt, startRaw, endRaw, vars);
  };

  function makeCall(fn, params) {
    var tw = new Tween([], { duration: 0, onComplete: fn, onReverseComplete: fn, onCompleteParams: params || [], onReverseCompleteParams: params || [] }, null);
    tw.vars.ease = "none";
    tw._callFn = fn;
    tw._initted = true;
    tw._props = [];
    return tw;
  }

  /** Stagger delays (observed: each → amount = each × (n − 1), or × max(rows, cols) for grids; distances normalised). */
  function distribute(cfg) {
    if (isNum(cfg)) cfg = { each: cfg };
    if (isFn(cfg)) return cfg;
    cfg = cfg || {};
    var ease = cfg.ease ? parseEase(cfg.ease) : null;
    var cache = null;
    return function (i, target, list) {
      var n = list.length;
      if (!cache || cache.n !== n) cache = buildDistribution(cfg, n, list, ease);
      return cache.values[i];
    };
  }
  function buildDistribution(cfg, n, list, ease) {
    var each = cfg.each, amount = cfg.amount, from = cfg.from == null ? "start" : cfg.from;
    var grid = cfg.grid, axis = cfg.axis;
    var negative = isNum(each) && each < 0;
    if (negative) { each = -each; if (from === "start") from = "end"; }
    var cols = n, rows = 1;
    if (grid) {
      if (grid === "auto") {
        // detect columns from layout: elements sharing the first element's top
        var top0 = list[0] && list[0].getBoundingClientRect ? list[0].getBoundingClientRect().top : 0;
        cols = 0;
        for (var c = 0; c < n; c++) {
          var tp = list[c] && list[c].getBoundingClientRect ? list[c].getBoundingClientRect().top : 0;
          if (Math.abs(tp - top0) < 1) cols++; else break;
        }
        cols = Math.max(1, cols);
        rows = Math.ceil(n / cols);
      } else { rows = grid[0]; cols = grid[1]; }
    }
    var fx, fy;
    if (isNum(from)) { fx = grid ? from % cols : from; fy = grid ? Math.floor(from / cols) : 0; }
    else if (Array.isArray(from)) { fx = from[0] * cols - 0.5; fy = (from[1] == null ? from[0] : from[1]) * rows - 0.5; }
    else {
      var ratio = from === "center" || from === "edges" ? 0.5 : from === "end" ? 1 : 0;
      fx = grid ? ratio * cols - 0.5 : ratio * n - 0.5;
      fy = grid ? ratio * rows - 0.5 : 0;
    }
    var d = [];
    var order = null;
    if (from === "random") {
      order = [];
      for (var q = 0; q < n; q++) order.push(q);
      for (var s = n - 1; s > 0; s--) { var j = Math.floor(rand() * (s + 1)); var tmp = order[s]; order[s] = order[j]; order[j] = tmp; }
    }
    for (var k = 0; k < n; k++) {
      var x = grid ? k % cols : k, y = grid ? Math.floor(k / cols) : 0;
      var dist;
      if (order) dist = order[k];
      else if (axis === "x") dist = Math.abs(x - fx);
      else if (axis === "y") dist = Math.abs(y - fy);
      else dist = Math.sqrt((x - fx) * (x - fx) + (y - fy) * (y - fy));
      d.push(dist);
    }
    var max = Math.max.apply(null, d), min = Math.min.apply(null, d);
    if (from === "edges") { for (var e2 = 0; e2 < n; e2++) d[e2] = max - d[e2]; var mx = max; max = mx - min; min = 0; }
    var span = max - min;
    var total;
    if (amount != null) total = +amount;
    else {
      var count = grid ? (axis === "x" ? cols : axis === "y" ? rows : Math.max(rows, cols)) : n - 1;
      total = (+each || 0) * count;
    }
    var values = d.map(function (dist) {
      var norm = span ? (dist - min) / span : 0;
      if (ease) norm = ease(norm);
      return (cfg.base || 0) + norm * total;
    });
    return { n: n, values: values };
  }

  function staggerTween(list, vars, parentDefaults, type, fromVars, rawTargets) {
    var stag = vars.stagger;
    var stagObj = isObj(stag) && !Array.isArray(stag) ? stag : null;
    var delayFn = isFn(stag) ? stag : distribute(stagObj || { each: +stag });
    var mainVars = {};
    var subVars = {};
    Object.keys(vars).forEach(function (k) {
      if (k === "stagger") return;
      if (/^on(Start|Update|Complete|Repeat|ReverseComplete)(Params)?$/.test(k) || k === "repeat" || k === "yoyo" || k === "repeatDelay" || k === "delay" || k === "callbackScope" || k === "id" || k === "paused" || k === "data") mainVars[k] = vars[k];
      else subVars[k] = vars[k];
    });
    var main = new Tween(list, mainVars, null);
    main._targets = list;
    main._subs = [];
    var subRepeat = stagObj ? pick(stagObj, ["repeat", "yoyo", "repeatDelay", "onComplete", "onCompleteParams", "onStart", "onStartParams", "onUpdate", "onUpdateParams", "onRepeat", "onReverseComplete"]) : {};
    var max = 0;
    list.forEach(function (t, i) {
      var sv = assign({}, subVars, subRepeat);
      var sub = new Tween(t, sv, parentDefaults);
      unregisterAnim(sub);
      // function-based values keep the index in the whole list
      sub._indexInList = i; sub._list = list;
      setupFrom(sub, type, fromVars);
      sub._start = delayFn(i, t, list);
      sub.parent = main;
      sub._order = i;
      var end = sub._start + sub.totalDuration();
      if (end > max) max = end;
      main._subs.push(sub);
    });
    main._subs.sort(function (a, b) { return a._start - b._start || a._order - b._order; });
    main._dur = max;
    main._immediate = main._subs.some(function (s) { return s._immediate; });
    return main;
  }
  function pick(o, keys) { var out = {}; keys.forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; }); return out; }

  function keyframeTween(targets, vars, parentDefaults, type, fromVars) {
    var kf = vars.keyframes;
    var mainVars = pick(vars, ["onStart", "onStartParams", "onUpdate", "onUpdateParams", "onComplete", "onCompleteParams", "repeat", "yoyo", "repeatDelay", "delay", "callbackScope", "id", "paused", "data"]);
    var main = new Tween(targets, mainVars, null);
    main._subs = [];
    var subs = main._subs;
    var t = 0;
    var order = 0;
    function addSub(v, start) {
      var sub = new Tween(targets, v, {});
      unregisterAnim(sub);
      setupFrom(sub, "to");
      sub._start = start; sub.parent = main; sub._order = order++;
      subs.push(sub);
      return sub;
    }
    var userDur = Object.prototype.hasOwnProperty.call(vars, "duration") ? +vars.duration : null;
    if (Array.isArray(kf)) {
      var each = userDur != null ? userDur / kf.length : null;
      kf.forEach(function (frame) {
        var v = assign({ ease: "none" }, frame);
        if (v.duration == null) v.duration = each != null ? each : GLOBAL_DEFAULTS.duration;
        var d = +v.delay || 0;
        delete v.delay;
        addSub(v, rt(t + d));
        t = rt(t + d + v.duration);
      });
      main._dur = t;
    } else if (isObj(kf)) {
      var dur = userDur != null ? userDur : GLOBAL_DEFAULTS.duration;
      var easeEach = kf.easeEach || "power1.inOut";
      var pctKeys = Object.keys(kf).filter(function (k) { return /%$/.test(k); });
      if (pctKeys.length) {
        pctKeys.sort(function (a, b) { return parseFloat(a) - parseFloat(b); });
        var prev = 0;
        pctKeys.forEach(function (k) {
          var p = parseFloat(k) / 100;
          var frame = assign({}, kf[k]);
          var ease = frame.ease || easeEach;
          delete frame.ease;
          if (p === 0) { addSub(assign(frame, { duration: 0, immediateRender: false }), 0); prev = 0; return; }
          addSub(assign(frame, { duration: (p - prev) * dur, ease: ease }), prev * dur);
          prev = p;
        });
      } else {
        Object.keys(kf).forEach(function (prop) {
          if (prop === "easeEach" || prop === "ease") return;
          var vals = kf[prop];
          if (!Array.isArray(vals) || !vals.length) return;
          var seg = vals.length > 1 ? dur / (vals.length - 1) : dur;
          var s0 = {}; s0[prop] = vals[0];
          addSub(assign(s0, { duration: 0, immediateRender: false }), 0);
          for (var i = 1; i < vals.length; i++) {
            var fr = {}; fr[prop] = vals[i];
            addSub(assign(fr, { duration: seg, ease: easeEach }), (i - 1) * seg);
          }
        });
      }
      main._dur = dur;
      if (vars.ease && Object.prototype.hasOwnProperty.call(vars, "ease")) {
        var outer = parseEase(vars.ease);
        main._warp = function (time) { return dur ? outer(time / dur) * dur : time; };
      }
    }
    subs.sort(function (a, b) { return a._start - b._start || a._order - b._order; });
    return main;
  }

  /** from()/fromTo()/immediateRender: initialise now and show the start state. */
  function afterInsert(tw) {
    if (!tw._immediate) return;
    var list = tw._subs ? tw._subs.filter(function (s) { return s._immediate; }) : [tw];
    list.forEach(function (s) {
      if (!s._initted) s._init(function () { return null; });
      s._immediateDone = true;
      s._apply(s._dur ? s._ease(0) : 0);
    });
  }

  // ================================================================ overwrite + registry
  var REG = new Map(); // target → Set(tween)
  function registerAnim(tw) {
    (tw._targets || []).forEach(function (t) {
      if (!isObj(t) && !isFn(t)) return;
      var s = REG.get(t);
      if (!s) { s = new Set(); REG.set(t, s); }
      s.add(tw);
    });
  }
  function unregisterAnim(tw) {
    (tw._targets || []).forEach(function (t) { var s = REG.get(t); if (s) s.delete(tw); });
  }
  function tweensOf(targets) {
    var out = [];
    uniqueTargets(targets).forEach(function (t) {
      var s = REG.get(t);
      if (s) s.forEach(function (tw) { if (!tw._killed && out.indexOf(tw) < 0) out.push(tw); });
    });
    return out;
  }
  function overwriteAll(tw) {
    tweensOf(tw._targets).forEach(function (other) { if (other !== tw) other.kill(); });
  }

  // ================================================================ canonical initialisation of a root
  /**
   * Every tween under `rootAnim` gets its start values as if the root had been played forward from 0: in order of
   * root-time start (ties: render order), a tween's start for (target, property) is the previous tween's value on it
   * at that moment, else the target's value now. `overwrite: "auto"` takes the property away from tweens still
   * running at that moment.
   */
  function initRootChain(rootAnim) {
    if (!rootAnim) return;
    rootAnim._chainDirty = false;
    var flat = [];
    var seq = 0;
    (function walk(anim, offset, scale) {
      var kids = anim instanceof Timeline ? anim._children : anim._subs;
      if (!kids) return;
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        var gs = offset + ch._start / scale;
        if (ch instanceof Timeline || ch._subs) walk(ch, gs, scale * ch._ts);
        if (ch instanceof Tween && !ch._subs) flat.push({ tw: ch, at: gs, seq: seq++ });
      }
    })(rootAnim, 0, 1);
    if (rootAnim instanceof Tween && !rootAnim._subs) flat.push({ tw: rootAnim, at: 0, seq: seq++ });
    flat.sort(function (a, b) { return a.at - b.at || a.seq - b.seq; });
    var last = new Map(); // target → { key → { tw, pt } }
    function lastFor(target, key) { var m = last.get(target); return m ? m[key] : undefined; }
    for (var i = 0; i < flat.length; i++) {
      var tw = flat[i].tw, at = flat[i].at;
      if (!tw._initted) {
        tw._init(function (target, kind, key) {
          var prev = lastFor(target, kind + ":" + key);
          if (!prev) return null;
          var v = prev.tw._valueAtRoot(prev.pt, at);
          if (kind === "tf" && (key === "x" || key === "y")) return { v: v, u: prev.pt.unitKey || "px" };
          return { v: v, u: prev.pt.u || undefined };
        });
      }
      if (tw._overwriteAuto || (tw.parent && tw.parent._overwriteAuto)) {
        // overwrite "auto": once this tween starts, earlier tweens still running on the same property stop writing it
        // (GSAP kills them when the later one first renders; here: from its start time on, so seeks stay pure)
        (tw._props || []).forEach(function (pt) {
          var m = last.get(pt.t);
          if (!m) return;
          (m["__all:" + pt.kind + ":" + pt.key] || []).forEach(function (e) {
            if (e.tw !== tw && e.start < at && e.end > at) { e.pt.deadAt = at; e.pt.root = rootAnim; }
          });
        });
      }
      (tw._props || []).forEach(function (pt) {
        var m = last.get(pt.t);
        if (!m) { m = {}; last.set(pt.t, m); }
        var k = pt.kind + ":" + pt.key;
        m[k] = { tw: tw, pt: pt };
        var all = m["__all:" + k] || (m["__all:" + k] = []);
        all.push({ tw: tw, pt: pt, start: at, end: at + tw.totalDuration() });
      });
    }
  }
  /** A tween's local total time for a root-local time (through every ancestor's start, scale, repeat and yoyo). */
  function localFromRoot(anim, rootTime) {
    var chain = [];
    var a = anim;
    while (a && a.parent && !a.parent._isGlobal) { chain.push(a); a = a.parent; }
    // a = the root; walk down
    var t = rootTime;
    var parentLocal = t; // root's own time: rootTime is already the root's local time
    if (anim !== a) {
      // map through the root's iteration first
      var it = iterTime(a, clamp(0, a.totalDuration(), t));
      parentLocal = a._warp ? a._warp(it.time) : it.time;
      if (t > a.totalDuration()) parentLocal = a._warp ? a._warp(it.time) : it.time;
    } else return t;
    for (var i = chain.length - 1; i >= 0; i--) {
      var c = chain[i];
      var tt = (parentLocal - c._start) * c._ts;
      if (i === 0) return tt;
      var cit = iterTime(c, clamp(0, c.totalDuration(), tt));
      parentLocal = c._warp ? c._warp(cit.time) : cit.time;
      if (tt < 0) parentLocal = tt; // before the child: keep negative so later tweens stay unstarted
    }
    return parentLocal;
  }

  /** Render an animation (and so its root) to a total time: the public time setters end here. */
  function seekRoot(anim, tt, suppress) {
    var r = anim._root();
    if (!r._isGlobal && r._chainDirty) initRootChain(r);
    if (!r._isGlobal && anim instanceof Tween && !anim._initted) initRootChain(r);
    anim.render(tt, suppress, false);
  }

  // ================================================================ the global timeline
  var globalTimeline = new Timeline({});
  globalTimeline._isGlobal = true;
  globalTimeline._root = function () { return this; };
  function addToGlobal(anim) {
    globalTimeline._insert(anim, 0);
    globalTimeline._chainDirty = false;
  }

  // ================================================================ utils
  function curry(fn, arity) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length >= arity) return fn.apply(null, args);
      return function (v) { return fn.apply(null, args.concat([v])); };
    };
  }
  function interpolate(a, b, p) {
    if (Array.isArray(a) && (b === undefined || isNum(b)) && p === undefined) {
      var arr = a;
      var f = function (prog) {
        var n = arr.length - 1;
        var x = clamp(0, 1, prog) * n;
        var i = Math.min(n - 1, Math.floor(x));
        return interpolate(arr[i], arr[i + 1], x - i);
      };
      return b === undefined ? f : f(b);
    }
    if (p === undefined) return function (q) { return interpolate(a, b, q); };
    if (isNum(a) && isNum(b)) return a + (b - a) * p;
    if (isStr(a) && isStr(b)) {
      var ca = parseColor(a.trim()), cb = parseColor(b.trim());
      if (ca && cb) return mixColor(ca, cb, p, false);
      return complexInterp(a, b, false)(p);
    }
    if (Array.isArray(a)) return a.map(function (v, i) { return interpolate(v, b[i], p); });
    if (isObj(a)) { var o = {}; Object.keys(a).forEach(function (k) { o[k] = interpolate(a[k], b[k], p); }); return o; }
    return p < 0.5 ? a : b;
  }
  function snapFn(snap, v) {
    var f;
    if (isNum(snap)) f = function (x) { return snap ? Math.round(x / snap) * snap : x; };
    else if (Array.isArray(snap)) f = function (x) { return closest(snap, x, Infinity); };
    else if (isObj(snap)) {
      var radius = snap.radius == null ? Infinity : snap.radius;
      if (Array.isArray(snap.values)) f = function (x) { return closest(snap.values, x, radius); };
      else { var inc = +snap.increment || 1; f = function (x) { var s = Math.round(x / inc) * inc; return Math.abs(s - x) <= radius ? s : x; }; }
    } else f = function (x) { return x; };
    return v === undefined ? f : f(v);
  }
  function closest(values, x, radius) {
    var best = x, bd = Infinity;
    values.forEach(function (c) {
      var d = isNum(c) ? Math.abs(c - x) : Math.sqrt(Math.pow(c.x - x.x, 2) + Math.pow(c.y - x.y, 2));
      if (d < bd) { bd = d; best = c; }
    });
    return bd <= radius ? best : x;
  }
  var utils = {
    toArray: function (v, scope) { return toArray(v, scope); },
    selector: function (scope) {
      var el = toArray(scope)[0];
      return function (sel) { return toArray(sel, el); };
    },
    clamp: curry(function (min, max, v) { return clamp(min, max, v); }, 3),
    mapRange: curry(function (a, b, c, d, v) { return b === a ? c : c + (v - a) / (b - a) * (d - c); }, 5),
    normalize: curry(function (a, b, v) { return b === a ? 0 : (v - a) / (b - a); }, 3),
    interpolate: interpolate,
    wrap: function (a, b, v) {
      if (Array.isArray(a)) { var arr = a; var f = function (i) { var n = arr.length; return arr[((Math.round(i) % n) + n) % n]; }; return b === undefined ? f : f(b); }
      var g = function (x) { var r = b - a; return r ? ((((x - a) % r) + r) % r) + a : a; };
      return v === undefined ? g : g(v);
    },
    wrapYoyo: function (a, b, v) {
      if (Array.isArray(a)) { var arr = a; var f = function (i) { var n = arr.length, c = 2 * (n - 1), k = ((Math.round(i) % c) + c) % c; return arr[k < n ? k : c - k]; }; return b === undefined ? f : f(b); }
      var g = function (x) { var r = b - a, c = r * 2; if (!r) return a; var k = ((((x - a) % c) + c) % c); return a + (k > r ? c - k : k); };
      return v === undefined ? g : g(v);
    },
    snap: snapFn,
    random: function (min, max, inc, returnFn) {
      if (Array.isArray(min)) {
        var arr = min, rf = max;
        var pickOne = function () { return arr[Math.floor(rand() * arr.length)]; };
        return rf === true ? pickOne : pickOne();
      }
      var make = function () {
        var v = min + rand() * (max - min);
        if (inc) v = Math.round(v / inc) * inc;
        return inc ? r6(v) : v;
      };
      return returnFn === true || (inc === true && (returnFn = true)) ? make : make();
    },
    shuffle: function (arr) {
      for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
      return arr;
    },
    distribute: function (cfg) {
      var f = distribute(cfg);
      return function (i, target, list) { return f(i, target, isNum(list) ? new Array(list) : list); };
    },
    getUnit: getUnit,
    unitize: function (fn, unit) {
      return function (v) { var u = unit || getUnit(v); return fn(parseFloat(v)) + u; };
    },
    pipe: function () { var fns = Array.prototype.slice.call(arguments); return function (v) { return fns.reduce(function (acc, f) { return f(acc); }, v); }; },
    splitColor: function (c, hsl) {
      var col = parseColor(String(c));
      if (!col) return null;
      var out = col.c[3] === 1 ? col.c.slice(0, 3) : col.c.slice();
      if (hsl) { var h = rgbToHsl(col.c[0], col.c[1], col.c[2]); out = [Math.round(h[0]), Math.round(h[1] * 100), Math.round(h[2] * 100)].concat(col.c[3] === 1 ? [] : [col.c[3]]); }
      return out;
    },
    checkPrefix: function (p) { return p; },
  };

  // ================================================================ getProperty / quickSetter
  function getProperty(target, prop, unit) {
    var t = toArray(target)[0];
    if (t == null) return undefined;
    if (prop === undefined) return function (p, u) { return getProperty(t, p, u); };
    if (isEl(t)) {
      var tk = TRANSFORM_KEYS[prop];
      if (tk) {
        var c = getCache(t);
        var v = tk === "scale" ? c.scaleX : c[tk];
        if (unit !== undefined) return v + (unit || (isRotKey(tk) ? "deg" : /^scale/.test(tk) ? "" : tk === "x" ? c.xu : tk === "y" ? c.yu : "px"));
        return v;
      }
      if (prop === "transformOrigin") return t.style.transformOrigin || getComputedStyle(t).transformOrigin;
      var raw = prop.indexOf("--") === 0 ? cssGet(t, prop) : (t.style[prop] || cssGet(t, prop));
      if (unit !== undefined) return parseFloat(raw) + (unit || getUnit(raw));
      var n = parseFloat(raw);
      return !isNaN(n) && String(raw).trim().match(/^[-+]?[\d.]+(e[-+]?\d+)?[a-z%]*$/i) ? n : raw;
    }
    var pv = isFn(t[prop]) ? t[prop]() : t[prop];
    return unit !== undefined && pv != null ? parseFloat(pv) + unit : pv;
  }
  function quickSetter(target, prop, unit) {
    var list = toArray(target);
    return function (v) {
      list.forEach(function (t) {
        var o = {}; o[prop] = unit ? v + unit : v;
        var tw = new Tween(t, assign(o, { duration: 0 }), null);
        unregisterAnim(tw);
        tw._init(function () { return null; });
        tw._apply(1);
      });
    };
  }

  // ================================================================ the gsap object
  function globalTween(targets, vars, type, fromVars) {
    var tw = createTween(targets, vars, {}, type, fromVars);
    addToGlobal(tw);
    if (type === "set" || (!tw._dur && !tw._subs)) {
      // gsap.set renders now
      if (!tw._initted) tw._init(function () { return null; });
      if (tw._subs) tw._subs.forEach(function (s) { if (!s._initted) s._init(function () { return null; }); s._done = true; s._zL = 0; s._apply(1); });
      else { tw._done = true; tw._zL = 0; tw._apply(1); }
      tw._rendered = true;
      if (tw.vars.onComplete) tw._fire("onComplete");
    } else afterInsert(tw);
    return tw;
  }
  var gsap = {
    __restorff: COMPAT_VERSION,
    version: "3.14.2",
    compat: "restorff-gsap-compat " + COMPAT_VERSION + " (clean-room, MIT; not GSAP)",
    to: function (targets, vars, v2) { if (isNum(vars)) vars = normVars(vars, v2); return globalTween(targets, vars, "to"); },
    from: function (targets, vars, v2) { if (isNum(vars)) vars = normVars(vars, v2); return globalTween(targets, vars, "from"); },
    fromTo: function (targets, fromVars, toVars, v3) { if (isNum(fromVars)) { var d = fromVars; fromVars = toVars; toVars = assign({}, v3, { duration: d }); } return globalTween(targets, toVars, "fromTo", fromVars); },
    set: function (targets, vars) { return globalTween(targets, assign({}, vars, { duration: 0 }), "set"); },
    timeline: function (vars) {
      var tl = new Timeline(vars, null);
      addToGlobal(tl);
      return tl;
    },
    delayedCall: function (delay, fn, params) {
      var tw = makeCall(fn, params);
      tw._delay = +delay || 0;
      addToGlobal(tw);
      return tw;
    },
    getProperty: getProperty,
    quickSetter: quickSetter,
    quickTo: function (target, prop, vars) {
      var setter = quickSetter(target, prop, vars && vars.unit);
      return function (v) { setter(v); };
    },
    parseEase: function (e) { return e === undefined ? EASES : parseEase(e); },
    registerEase: function (name, fn) { EASES[name] = fn; },
    registerPlugin: function () {
      for (var i = 0; i < arguments.length; i++) {
        var p = arguments[i];
        if (p && p.__rcPlugin && p.register) p.register(gsap);
      }
    },
    registerEffect: function (cfg) {
      gsap.effects[cfg.name] = function (targets, config) { return cfg.effect(toArray(targets), assign({}, cfg.defaults, config)); };
      if (cfg.extendTimeline) TL[cfg.name] = function (targets, config, position) { this.add(gsap.effects[cfg.name](targets, config), position); return this; };
    },
    effects: {},
    defaults: function (v) { if (v) { assign(GLOBAL_DEFAULTS, v); if (v.ease) GLOBAL_DEFAULTS.ease = v.ease; } return GLOBAL_DEFAULTS; },
    config: function () { return {}; },
    getTweensOf: function (targets, onlyActive) { return tweensOf(targets).filter(function (t) { return !onlyActive || t.isActive(); }); },
    killTweensOf: function (targets, props) {
      tweensOf(targets).forEach(function (tw) {
        if (!props) { tw.kill(); return; }
        var list = isStr(props) ? props.split(",").map(function (s) { return s.trim(); }) : Object.keys(props);
        (tw._props || []).forEach(function (pt) { if (list.indexOf(pt.key) >= 0) pt.alive = false; });
      });
    },
    isTweening: function (targets) { return tweensOf(targets).some(function (t) { return t.isActive(); }); },
    getById: function (id) { return BY_ID[id]; },
    exportRoot: function () { var tl = new Timeline({}); globalTimeline._children.slice().forEach(function (c) { tl.add(c, c._start); }); addToGlobal(tl); return tl; },
    globalTimeline: globalTimeline,
    ticker: {
      add: function () {}, remove: function () {}, fps: function () {}, lagSmoothing: function () {}, sleep: function () {},
      wake: function () {}, tick: function () {}, deltaRatio: function () { return 1; }, time: 0, frame: 0,
    },
    updateRoot: function () {},
    context: function (fn, scope) {
      var made = [];
      var ctx = {
        add: function (f) { if (isFn(f)) return f(); return f; },
        revert: function () { made.forEach(function (a) { a.revert(); }); },
        kill: function () { made.forEach(function (a) { a.kill(); }); },
        ignore: function (f) { return f(); },
        selector: scope ? utils.selector(scope) : toArray,
      };
      if (isFn(fn)) fn(ctx);
      return ctx;
    },
    matchMedia: function () {
      return {
        add: function (cond, fn) {
          if (isStr(cond)) { if (root.matchMedia && root.matchMedia(cond).matches) fn({}); return; }
          var res = {};
          Object.keys(cond || {}).forEach(function (k) { res[k] = cond[k] === true || (root.matchMedia ? root.matchMedia(cond[k]).matches : false); });
          fn({ conditions: res });
        },
        revert: function () {}, kill: function () {},
      };
    },
    utils: utils,
    core: { Animation: Animation, Tween: Tween, Timeline: Timeline, PropTween: PropTween, globals: function () {} },
    plugins: PLUGINS,
  };

  // ================================================================ plugin helpers + plugins
  function definePlugin(name, plugin) { PLUGINS[name] = plugin; }
  gsap.__definePlugin = definePlugin;
  gsap.__internal = { getCache: getCache, renderTransform: renderTransform, parseEase: parseEase, rand: rand, PropTween: PropTween, toArray: toArray, iterTime: iterTime };

  // ---- CustomEase: cubic Bézier paths ("M0,0 C0.25,0 0.2,1 1,1", several segments, or "x1,y1,x2,y2")
  function parsePathEase(data) {
    var s = String(data).trim();
    var nums = (s.match(NUM_RE) || []).map(parseFloat);
    if (!/[a-z]/i.test(s) && nums.length === 4) return [[0, 0, nums[0], nums[1], nums[2], nums[3], 1, 1]];
    var segs = [];
    var cmdRe = /([MLCSmlcs])([^MLCSmlcs]*)/g;
    var m, cx = 0, cy = 0, lastC2 = null;
    while ((m = cmdRe.exec(s))) {
      var cmd = m[1], args = (m[2].match(NUM_RE) || []).map(parseFloat);
      var rel = cmd === cmd.toLowerCase();
      var C = cmd.toUpperCase();
      var i = 0;
      if (C === "M") { cx = args[0] + (rel ? cx : 0); cy = args[1] + (rel ? cy : 0); i = 2; lastC2 = null; C = "L"; }
      while (i + 1 < args.length || (C !== "L" && i < args.length)) {
        if (C === "L") {
          var x = args[i] + (rel ? cx : 0), y = args[i + 1] + (rel ? cy : 0);
          segs.push([cx, cy, cx + (x - cx) / 3, cy + (y - cy) / 3, cx + 2 * (x - cx) / 3, cy + 2 * (y - cy) / 3, x, y]);
          cx = x; cy = y; i += 2; lastC2 = null;
        } else if (C === "C") {
          if (i + 5 >= args.length) break;
          var x1 = args[i] + (rel ? cx : 0), y1 = args[i + 1] + (rel ? cy : 0), x2 = args[i + 2] + (rel ? cx : 0), y2 = args[i + 3] + (rel ? cy : 0);
          var x3 = args[i + 4] + (rel ? cx : 0), y3 = args[i + 5] + (rel ? cy : 0);
          segs.push([cx, cy, x1, y1, x2, y2, x3, y3]);
          lastC2 = [x2, y2]; cx = x3; cy = y3; i += 6;
        } else if (C === "S") {
          if (i + 3 >= args.length) break;
          var rx = lastC2 ? 2 * cx - lastC2[0] : cx, ry = lastC2 ? 2 * cy - lastC2[1] : cy;
          var sx2 = args[i] + (rel ? cx : 0), sy2 = args[i + 1] + (rel ? cy : 0), sx3 = args[i + 2] + (rel ? cx : 0), sy3 = args[i + 3] + (rel ? cy : 0);
          segs.push([cx, cy, rx, ry, sx2, sy2, sx3, sy3]);
          lastC2 = [sx2, sy2]; cx = sx3; cy = sy3; i += 4;
        } else break;
      }
    }
    return segs;
  }
  function bez(a, b, c, d, t) { var u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; }
  function makePathEase(data) {
    var segs = parsePathEase(data);
    if (!segs.length) return linear;
    var x0 = segs[0][0], x1 = segs[segs.length - 1][6];
    var y0 = segs[0][1], y1 = segs[segs.length - 1][7];
    // normalise to 0..1 on x (GSAP's paths are already 0..1; be lenient)
    var sx = x1 - x0 || 1;
    return function (p) {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      var x = x0 + p * sx;
      var seg = segs[segs.length - 1];
      for (var i = 0; i < segs.length; i++) if (x <= segs[i][6]) { seg = segs[i]; break; }
      var lo = 0, hi = 1, t = 0.5;
      for (var k = 0; k < 40; k++) {
        t = (lo + hi) / 2;
        var bx = bez(seg[0], seg[2], seg[4], seg[6], t);
        if (Math.abs(bx - x) < 1e-7) break;
        if (bx < x) lo = t; else hi = t;
      }
      var y = bez(seg[1], seg[3], seg[5], seg[7], t);
      return (y - y0) / ((y1 - y0) || 1) * (y1 - y0) + y0 === y ? y : y;
    };
  }
  var CustomEase = {
    __rcPlugin: true,
    create: function (id, data) {
      var fn = makePathEase(data);
      if (id) EASES[id] = fn;
      return fn;
    },
    get: function (id) { return EASES[id]; },
    getSVGData: function () { return ""; },
    register: function () {},
  };
  CustomEase.version = gsap.version;

  // ---- MotionPathPlugin: follow an SVG path (selector, element, path data) or points
  var _svgNS = "http://www.w3.org/2000/svg";
  var _helperSvg = null;
  function pathElementFor(p) {
    if (isStr(p) && !/^[mM]/.test(p.trim())) { var el = toArray(p)[0]; if (el) return el; }
    if (isEl(p) && typeof p.getTotalLength === "function") return p;
    var d = isStr(p) ? p : isEl(p) ? p.getAttribute("d") : null;
    if (!d) return null;
    if (!_helperSvg) {
      _helperSvg = document.createElementNS(_svgNS, "svg");
      _helperSvg.setAttribute("width", "0"); _helperSvg.setAttribute("height", "0");
      _helperSvg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
      (document.body || document.documentElement).appendChild(_helperSvg);
    }
    var path = document.createElementNS(_svgNS, "path");
    path.setAttribute("d", d);
    _helperSvg.appendChild(path);
    path.__rcDetached = true;
    return path;
  }
  function catmull(points) {
    // a smooth path through points (curviness 1): Catmull–Rom → cubic Bézier segments as path data
    if (points.length < 2) return "M" + (points[0] ? points[0].x + "," + points[0].y : "0,0");
    var d = "M" + points[0].x + "," + points[0].y;
    for (var i = 0; i < points.length - 1; i++) {
      var p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
      d += " C" + (p1.x + (p2.x - p0.x) / 6) + "," + (p1.y + (p2.y - p0.y) / 6) + " " + (p2.x - (p3.x - p1.x) / 6) + "," + (p2.y - (p3.y - p1.y) / 6) + " " + p2.x + "," + p2.y;
    }
    return d;
  }
  var MotionPathPlugin = {
    __rcPlugin: true,
    register: function () {},
    getRelativePosition: function () { return { x: 0, y: 0 }; },
    convertToPath: function (el) { return toArray(el); },
  };
  definePlugin("motionPath", {
    init: function (pt, cfg, tween) {
      var target = pt.t;
      if (!isEl(target) && !isObj(target)) return false;
      if (Array.isArray(cfg) || (isObj(cfg) && Array.isArray(cfg.path))) {
        var pts = Array.isArray(cfg) ? cfg : cfg.path;
        cfg = assign({}, isObj(cfg) && !Array.isArray(cfg) ? cfg : {}, { path: null });
        var startPt = isEl(target) ? { x: getCache(target).x, y: getCache(target).y } : { x: target.x || 0, y: target.y || 0 };
        cfg.__points = [startPt].concat(pts);
      } else if (!isObj(cfg) || cfg.nodeType) cfg = { path: cfg };
      var path = cfg.__points ? pathElementFor(catmull(cfg.__points)) : pathElementFor(cfg.path);
      if (!path) { warn("motionPath: path not found"); return false; }
      pt.path = path;
      pt.len = path.getTotalLength();
      pt.start = cfg.start == null ? 0 : +cfg.start;
      pt.end = cfg.end == null ? 1 : +cfg.end;
      pt.autoRotate = cfg.autoRotate === true ? 0 : isNum(cfg.autoRotate) ? cfg.autoRotate : null;
      pt.offsetX = +cfg.offsetX || 0; pt.offsetY = +cfg.offsetY || 0;
      var align = cfg.align;
      pt.el = isEl(target);
      if (pt.el) {
        var c = getCache(target);
        pt.baseX = c.x; pt.baseY = c.y; pt.baseRot = c.rotation;
        if (align) {
          var ao = cfg.alignOrigin || [0.5, 0.5];
          // measure the untransformed box and the screen scale of its parent
          var saveT = target.style.transform;
          target.style.transform = "none";
          var rect = target.getBoundingClientRect();
          target.style.transform = saveT;
          var w = target.offsetWidth || rect.width, h = target.offsetHeight || rect.height;
          var scale = w ? rect.width / w : 1;
          pt.scale = scale || 1;
          pt.originScreen = { x: rect.left + ao[0] * rect.width, y: rect.top + ao[1] * rect.height };
          pt.ctm = path.getScreenCTM();
          pt.align = true;
          if (pt.autoRotate !== null) target.style.transformOrigin = (ao[0] * 100) + "% " + (ao[1] * 100) + "%";
        }
      }
      return true;
    },
    render: function (pt, r) {
      var u = pt.start + (pt.end - pt.start) * r;
      var L = clamp(0, 1, u) * pt.len;
      var p = pt.path.getPointAtLength(L);
      var e = 0.5;
      var pA = pt.path.getPointAtLength(clamp(0, pt.len, L - e)), pB = pt.path.getPointAtLength(clamp(0, pt.len, L + e));
      var x, y, ang = Math.atan2(pB.y - pA.y, pB.x - pA.x) * DEG;
      if (pt.align && pt.ctm) {
        var m = pt.ctm;
        var sx = m.a * p.x + m.c * p.y + m.e, sy = m.b * p.x + m.d * p.y + m.f;
        x = (sx - pt.originScreen.x) / pt.scale; y = (sy - pt.originScreen.y) / pt.scale;
        ang = Math.atan2(m.b * (pB.x - pA.x) + m.d * (pB.y - pA.y), m.a * (pB.x - pA.x) + m.c * (pB.y - pA.y)) * DEG;
      } else { x = p.x; y = p.y; }
      x += pt.offsetX; y += pt.offsetY;
      if (pt.el) {
        var c = getCache(pt.t);
        c.x = x; c.y = y;
        if (pt.autoRotate !== null) c.rotation = ang + pt.autoRotate;
        renderTransform(pt.t, c);
      } else {
        pt.t.x = x; pt.t.y = y;
        if (pt.autoRotate !== null) pt.t.rotation = ang + pt.autoRotate;
      }
    },
  });

  // ---- TextPlugin: text: "new words" | { value, delimiter }
  var TextPlugin = { __rcPlugin: true, register: function () {} };
  definePlugin("text", {
    init: function (pt, cfg) {
      if (!isEl(pt.t)) return false;
      var c = isObj(cfg) ? cfg : { value: cfg };
      pt.from = pt.t.textContent;
      pt.to = String(c.value == null ? "" : c.value);
      pt.delim = c.delimiter || "";
      return true;
    },
    render: function (pt, r) {
      var a = pt.delim ? pt.from.split(pt.delim) : Array.from(pt.from);
      var b = pt.delim ? pt.to.split(pt.delim) : Array.from(pt.to);
      var n = Math.round(r * Math.max(a.length, b.length));
      pt.t.textContent = b.slice(0, n).concat(a.slice(n)).join(pt.delim);
    },
  });

  // ---- ScrambleTextPlugin: scrambleText: "words" | { text, chars, revealDelay, speed } (seeded, frame-deterministic)
  var ScrambleTextPlugin = { __rcPlugin: true, register: function () {} };
  definePlugin("scrambleText", {
    init: function (pt, cfg) {
      if (!isEl(pt.t)) return false;
      var c = isObj(cfg) ? cfg : { text: cfg };
      pt.to = String(c.text == null ? pt.t.textContent : c.text);
      pt.from = pt.t.textContent;
      var chars = c.chars || "upperCase";
      pt.chars = chars === "upperCase" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : chars === "lowerCase" ? "abcdefghijklmnopqrstuvwxyz" : String(chars);
      pt.reveal = +c.revealDelay || 0;
      pt.seed = Math.floor(rand() * 1e9);
      return true;
    },
    render: function (pt, r) {
      var b = Array.from(pt.to);
      var revealed = r <= pt.reveal ? 0 : Math.round((r - pt.reveal) / (1 - pt.reveal || 1) * b.length);
      var step = Math.floor(r * 60);
      var out = "";
      for (var i = 0; i < b.length; i++) {
        if (i < revealed || b[i] === " ") { out += b[i]; continue; }
        var h = Math.imul((pt.seed ^ (i * 374761393) ^ (step * 668265263)) >>> 0, 2246822519) >>> 0;
        out += pt.chars[h % pt.chars.length];
      }
      pt.t.textContent = r >= 1 ? pt.to : out;
    },
  });

  // ---- DrawSVGPlugin: drawSVG: "0% 100%" | "20% 80%" | number (length or percent of the stroke)
  var DrawSVGPlugin = { __rcPlugin: true, register: function () {}, getLength: function (el) { var t = toArray(el)[0]; return t && t.getTotalLength ? t.getTotalLength() : 0; } };
  function drawRange(v, len) {
    var s = String(v).trim().split(/\s+/);
    function one(x) { return x.indexOf("%") > 0 ? parseFloat(x) / 100 * len : parseFloat(x); }
    if (s.length === 1) return [0, one(s[0])];
    return [one(s[0]), one(s[1])];
  }
  definePlugin("drawSVG", {
    init: function (pt, cfg, tween, i, all, from) {
      var el = pt.t;
      if (!isEl(el) || typeof el.getTotalLength !== "function") return false;
      var len = el.getTotalLength();
      pt.len = len;
      var start = [0, len];
      if (from !== undefined) start = drawRange(from === true ? "100%" : from, len);
      else {
        var cs = getComputedStyle(el);
        var da = cs.strokeDasharray, doff = parseNum(cs.strokeDashoffset);
        if (da && da !== "none") { var first = parseNum(da.split(/[ ,]+/)[0]); start = [-doff, -doff + first]; }
      }
      pt.sv = start;
      pt.ev = drawRange(cfg === true ? "100%" : cfg, len);
      return true;
    },
    render: function (pt, r) {
      // observed format: "<visible>px, <gap>px" (gap = rest + 0.1, or 999999 when nothing is drawn), offset = -start
      var a = pt.sv[0] + (pt.ev[0] - pt.sv[0]) * r, b = pt.sv[1] + (pt.ev[1] - pt.sv[1]) * r;
      var lo = Math.min(a, b), hi = Math.max(a, b), vis = r4(hi - lo);
      pt.t.style.strokeDasharray = vis + "px, " + (vis > 0 ? r4(pt.len - vis + 0.1) : 999999) + "px";
      pt.t.style.strokeDashoffset = String(r4(-lo) || 0);
    },
  });

  // ---- SplitText: new SplitText(el, { type: "chars,words,lines" }) → { chars, words, lines, revert() }
  function SplitText(target, vars) {
    if (!(this instanceof SplitText)) return new SplitText(target, vars);
    vars = vars || {};
    var type = vars.type || "chars,words,lines";
    var self = this;
    this.elements = toArray(target);
    this.chars = []; this.words = []; this.lines = [];
    this._originals = this.elements.map(function (el) { return el.innerHTML; });
    this.elements.forEach(function (el) {
      var text = el.textContent;
      el.innerHTML = "";
      var wantChars = type.indexOf("chars") >= 0, wantWords = type.indexOf("words") >= 0 || wantChars, wantLines = type.indexOf("lines") >= 0;
      var words = text.split(/(\s+)/);
      var wordEls = [];
      words.forEach(function (w) {
        if (!w) return;
        if (/^\s+$/.test(w)) { el.appendChild(document.createTextNode(" ")); return; }
        var wd = document.createElement("div");
        wd.style.cssText = "position:relative;display:inline-block";
        if (vars.wordsClass) wd.className = vars.wordsClass.replace("++", String(self.words.length + 1));
        if (wantChars) {
          Array.from(w).forEach(function (ch) {
            var cd = document.createElement("div");
            cd.style.cssText = "position:relative;display:inline-block";
            if (vars.charsClass) cd.className = vars.charsClass.replace("++", String(self.chars.length + 1));
            cd.textContent = ch;
            wd.appendChild(cd);
            self.chars.push(cd);
          });
        } else wd.textContent = w;
        el.appendChild(wd);
        wordEls.push(wd);
        if (wantWords) self.words.push(wd);
      });
      if (wantLines) {
        var lines = [], top = null, cur = null;
        wordEls.forEach(function (wd) {
          var t = wd.offsetTop;
          if (top === null || Math.abs(t - top) > 2) { cur = []; lines.push(cur); top = t; }
          cur.push(wd);
        });
        el.innerHTML = "";
        lines.forEach(function (ws, li) {
          var ld = document.createElement("div");
          ld.style.cssText = "position:relative;display:block;text-align:inherit";
          if (vars.linesClass) ld.className = vars.linesClass.replace("++", String(li + 1));
          ws.forEach(function (wd, wi) { if (wi) ld.appendChild(document.createTextNode(" ")); ld.appendChild(wd); });
          el.appendChild(ld);
          self.lines.push(ld);
        });
      }
    });
  }
  SplitText.prototype.revert = function () { var o = this._originals; this.elements.forEach(function (el, i) { el.innerHTML = o[i]; }); };
  SplitText.create = function (t, v) { return new SplitText(t, v); };
  SplitText.__rcPlugin = true;
  SplitText.register = function () {};


  // ================================================================ export
  root.gsap = gsap;
  root.CustomEase = CustomEase;
  root.MotionPathPlugin = MotionPathPlugin;
  root.TextPlugin = TextPlugin;
  root.ScrambleTextPlugin = ScrambleTextPlugin;
  root.DrawSVGPlugin = DrawSVGPlugin;
  root.SplitText = SplitText;
  root.EasePack = { __rcPlugin: true, register: function () {} };
})(typeof window !== "undefined" ? window : globalThis);
