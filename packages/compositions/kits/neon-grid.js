/* ---------------------------------------------------------------------------------------------------------------
   neon-grid kit (library kit, composition-v3 2026-10-21). Shared by the eight neon-* library compositions and by any
   custom composition whose timeline kit is set from it (MCP `composition kit {library_kit: "neon-grid"}`).
   Taken from the neon-grid recreation's kit (docs/restorff/recreations/neon-grid-type, Opus 2026-10-20), plus the
   param-driven parts every piece shares. It only DEFINES (no RC.composition); everything is a pure function of its
   arguments, so pieces stay seekable by time.

   - Camera: a real 3D pinhole camera (yaw / pitch / roll, near-plane clipping) projecting onto a full-frame canvas.
   - drawGrid: the floor plane y = 0, one line per world unit, faded by distance, accent axes, horizon bloom.
   - drawSolid: wireframe cube / octahedron / pyramid.
   - ignite(): a word flashes in the accent with bloom, then cools to bone white.
   - Captions: the voice-over word by word (1-3 words per chunk), key words in the accent.
   - Timing: every time a piece takes is TIMELINE seconds; `t0` = where the clip starts. An item {at, word, text}
     resolves to `at` when at >= 0, else to the VO word (`word`, else the first word of `text`) in `words`, searched
     in order after the previous item, else to the piece's own default.
   - cue(): sound cues computed from the params, collected in window.__rcCues (real seconds into the clip); the
     renderer writes them to the render's sidecar, where sound design reads them first.
   No story words live here: every word on screen comes from a piece's params.
   --------------------------------------------------------------------------------------------------------------- */
var KIT = (function () {
  var BONE = "#F2EEE6";
  var INK = "#07070A";
  var FOG = "#8C8C95";
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function sstep(a, b, x) { var k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); }

  function Camera(W, H, fovDeg) {
    this.W = W; this.H = H;
    this.f = H / 2 / Math.tan((fovDeg * Math.PI) / 360);
    this.set(0, 1.4, 0, 0, -10, 0);
  }
  Camera.prototype.set = function (x, y, z, yaw, pitch, roll) {
    var d = Math.PI / 180;
    this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.pitch = pitch; this.roll = roll || 0;
    this.cy = Math.cos(yaw * d); this.sy = Math.sin(yaw * d);
    this.cp = Math.cos(pitch * d); this.sp = Math.sin(pitch * d);
    this.cr = Math.cos(this.roll * d); this.sr = Math.sin(this.roll * d);
    return this;
  };
  /** Point the camera from (x, y, z) at a target. */
  Camera.prototype.lookAt = function (x, y, z, tx, ty, tz, roll) {
    var dx = tx - x, dy = ty - y, dz = tz - z;
    var yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
    var pitch = (Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI;
    return this.set(x, y, z, yaw, pitch, roll || 0);
  };
  /** World -> camera space [x, y, depth]. */
  Camera.prototype.view = function (x, y, z) {
    var dx = x - this.x, dy = y - this.y, dz = z - this.z;
    var x1 = dx * this.cy - dz * this.sy, z1 = dx * this.sy + dz * this.cy;
    var y2 = dy * this.cp - z1 * this.sp, z2 = dy * this.sp + z1 * this.cp;
    return [x1 * this.cr - y2 * this.sr, x1 * this.sr + y2 * this.cr, z2];
  };
  Camera.prototype.screen = function (v) {
    return [this.W / 2 + (this.f * v[0]) / v[2], this.H / 2 - (this.f * v[1]) / v[2]];
  };
  /** World point -> [sx, sy, depth] or null when behind the camera. */
  Camera.prototype.point = function (x, y, z) {
    var v = this.view(x, y, z);
    if (v[2] < 0.05) return null;
    var s = this.screen(v);
    return [s[0], s[1], v[2]];
  };
  /** Camera-space segment -> two screen points, clipped to the near plane; null when fully behind. */
  Camera.prototype.seg = function (a, b) {
    var n = 0.05, k;
    if (a[2] < n && b[2] < n) return null;
    if (a[2] < n) { k = (n - a[2]) / (b[2] - a[2]); a = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, n]; }
    else if (b[2] < n) { k = (n - b[2]) / (a[2] - b[2]); b = [b[0] + (a[0] - b[0]) * k, b[1] + (a[1] - b[1]) * k, n]; }
    return [this.screen(a), this.screen(b)];
  };
  Camera.prototype.line3 = function (ctx, x0, y0, z0, x1, y1, z1) {
    var s = this.seg(this.view(x0, y0, z0), this.view(x1, y1, z1));
    if (!s) return false;
    ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]);
    return true;
  };

  /** Dark backdrop with a soft lift in the middle. */
  function backdrop(ctx, W, H) {
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);
    var g = ctx.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, H * 0.62);
    g.addColorStop(0, "#16161C");
    g.addColorStop(1, "rgba(7,7,10,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  function vignette(ctx, W, H, a) {
    var g = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0," + (a == null ? 0.6 : a) + ")");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * The floor grid. o = { color, alpha, lw, reach, accent, axes (0..1), ax, az (axis position), glow (0..1), u }.
   * Lines are bucketed by their distance fade (10 strokes per frame instead of thousands).
   */
  function drawGrid(ctx, cam, o) {
    var R = o.reach || 30, B = 10, u = o.u || 1;
    var cx = Math.round(cam.x), cz = Math.round(cam.z);
    var paths = [], i;
    for (i = 0; i < B; i++) paths.push(new Path2D());
    function add(x0, z0, x1, z1) {
      var mx = (x0 + x1) / 2 - cam.x, mz = (z0 + z1) / 2 - cam.z;
      var al = 1 - sstep(R * 0.2, R * 0.92, Math.sqrt(mx * mx + mz * mz));
      if (al <= 0.03) return;
      var s = cam.seg(cam.view(x0, 0, z0), cam.view(x1, 0, z1));
      if (!s) return;
      var p = paths[Math.min(B - 1, Math.floor(al * B))];
      p.moveTo(s[0][0], s[0][1]); p.lineTo(s[1][0], s[1][1]);
    }
    for (var gx = cx - R; gx <= cx + R; gx++) {
      for (var gz = cz - R; gz <= cz + R; gz++) { add(gx, gz, gx, gz + 1); add(gx, gz, gx + 1, gz); }
    }
    ctx.save();
    ctx.lineCap = "round";
    for (i = 0; i < B; i++) {
      var k = (i + 0.5) / B;
      ctx.strokeStyle = RC.alpha(o.color || BONE, (o.alpha == null ? 0.22 : o.alpha) * k);
      ctx.lineWidth = (o.lw || 1.6) * u * (0.55 + 0.45 * k);
      ctx.stroke(paths[i]);
    }
    // accent axes through (ax, az), with bloom
    if (o.axes > 0.01) {
      ctx.shadowColor = o.accent; ctx.shadowBlur = 18 * u;
      ctx.lineWidth = 3 * u;
      for (var j = -R; j < R; j++) {
        var d = Math.abs(j) / R;
        var a = o.axes * (1 - sstep(0.15, 0.9, d));
        if (a <= 0.02) continue;
        ctx.strokeStyle = RC.alpha(o.accent, a);
        ctx.beginPath();
        cam.line3(ctx, o.ax, 0, o.az + j, o.ax, 0, o.az + j + 1);
        cam.line3(ctx, o.ax + j, 0, o.az, o.ax + j + 1, 0, o.az);
        ctx.stroke();
      }
    }
    ctx.restore();
    // horizon bloom: the vanishing line of the floor, straight ahead at eye level
    if (o.glow > 0.01) {
      var h = cam.point(cam.x + 1e4 * cam.sy, cam.y, cam.z + 1e4 * cam.cy);
      if (h && h[1] > -300 && h[1] < cam.H + 300) {
        var band = 260 * u;
        var g = ctx.createLinearGradient(0, h[1] - band, 0, h[1] + band);
        g.addColorStop(0, RC.alpha(o.accent, 0));
        g.addColorStop(0.5, RC.alpha(o.accent, 0.16 * o.glow));
        g.addColorStop(1, RC.alpha(o.accent, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, h[1] - band, cam.W, band * 2);
      }
    }
  }

  var SOLIDS = {
    cube: { v: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      e: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] },
    octa: { v: [[1.3, 0, 0], [-1.3, 0, 0], [0, 1.3, 0], [0, -1.3, 0], [0, 0, 1.3], [0, 0, -1.3]],
      e: [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]] },
    pyra: { v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, 1.2, 0]],
      e: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]] },
  };
  /** Wireframe solid at world pos, size s, spun by ry / rx degrees. */
  function drawSolid(ctx, cam, kind, pos, s, ry, rx, color, a, lw, glow) {
    var S = SOLIDS[kind];
    if (!S || a <= 0.01) return;
    var d = Math.PI / 180, cy = Math.cos(ry * d), sy = Math.sin(ry * d), cx = Math.cos(rx * d), sx = Math.sin(rx * d);
    var w = S.v.map(function (v) {
      var x = v[0] * cy - v[2] * sy, z = v[0] * sy + v[2] * cy;
      var y = v[1] * cx - z * sx; z = v[1] * sx + z * cx;
      return [pos[0] + x * s, pos[1] + y * s, pos[2] + z * s];
    });
    ctx.save();
    ctx.strokeStyle = RC.alpha(color, a);
    ctx.lineWidth = lw; ctx.lineJoin = "round";
    if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
    ctx.beginPath();
    S.e.forEach(function (e) { cam.line3(ctx, w[e[0]][0], w[e[0]][1], w[e[0]][2], w[e[1]][0], w[e[1]][1], w[e[1]][2]); });
    ctx.stroke();
    ctx.restore();
  }

  /** Ignite then cool: flash in the accent with bloom at `s`, hold, cool to bone over ~0.5 s. */
  function ignite(node, g, s, accent, u, hold, base) {
    var k = RC.progress(g, s + (hold == null ? 0.28 : hold), 0.5, "smooth");
    var glow = g < s ? 0 : 1 - k;
    node.style.color = RC.mixColor(accent, base || BONE, k);
    node.style.textShadow =
      "0 0 " + 12 * u + "px " + RC.alpha(accent, 0.95 * glow) + ", 0 0 " + 42 * u + "px " + RC.alpha(accent, 0.75 * glow) +
      ", 0 0 " + 110 * u + "px " + RC.alpha(accent, 0.5 * glow) + ", 0 " + 6 * u + "px " + 24 * u + "px rgba(0,0,0,.55)";
  }
  /** Left -> right reveal of a block (glow may spill above and below). */
  function reveal(node, p) {
    node.style.clipPath = "inset(-60% " + ((1 - clamp(p, 0, 1)) * 100).toFixed(3) + "% -60% -12%)";
  }
  function norm(w) { return String(w == null ? "" : w).toLowerCase().replace(/[^a-z0-9-]/g, ""); }

  // ---------------------------------------------------------------- timing from params + the voice
  var NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  var TENS = { 20: "twenty", 30: "thirty", 40: "forty", 50: "fifty", 60: "sixty", 70: "seventy", 80: "eighty", 90: "ninety" };
  /** "18" -> "eighteen", "24" -> "twenty-four" (0..99), else null. */
  function numberWord(token) {
    if (!/^\d{1,2}$/.test(token)) return null;
    var n = +token;
    if (n <= 20) return NUMBER_WORDS[n];
    var t = Math.floor(n / 10) * 10, r = n % 10;
    return TENS[t] + (r ? "-" + NUMBER_WORDS[r] : "");
  }
  /** The first word of a display text, as the voice would say it ("18 H" -> "eighteen", "OF TIME?" -> "of"). */
  function firstWord(text) {
    var m = String(text == null ? "" : text).match(/[A-Za-z0-9][A-Za-z0-9'-]*/);
    if (!m) return "";
    var n = numberWord(m[0]);
    return n || m[0];
  }

  /**
   * Times of a piece. P = the params (t0, words), dur = the clip's length. Items resolve in call order: each VO search
   * starts after the previous resolved time, so a repeated word ("not ... not") finds its next occurrence.
   */
  function Timing(P, dur) {
    this.t0 = typeof P.t0 === "number" ? P.t0 : 0;
    this.dur = dur;
    this.end = this.t0 + dur;
    this.words = (P.words || []).filter(function (w) { return w && typeof w.w === "string" && typeof w.s === "number"; })
      .slice().sort(function (a, b) { return a.s - b.s; });
    this.cursor = this.t0 - 0.25;
  }
  /** Start of the first VO word matching `key` at or after `from` (timeline s), or null. */
  Timing.prototype.find = function (key, from) {
    var k = norm(key);
    if (!k) return null;
    var alt = numberWord(k);
    var list = this.words;
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (w.s < from - 1e-6) continue;
        var n = norm(w.w);
        if (n === k || (alt && n === alt)) return w.s;
        if (pass === 1 && k.length >= 4 && (n.indexOf(k) === 0 || k.indexOf(n) === 0) && n.length >= 3) return w.s;
      }
    }
    return null;
  };
  /**
   * When an item happens: item.at (>= 0) wins; else the VO word item.word, else the first word of item.text (or of
   * `text`); else `fallback` (the piece's default, timeline seconds). Moves the search cursor forward.
   */
  Timing.prototype.at = function (item, fallback, text) {
    var t = null;
    if (item && typeof item.at === "number" && item.at >= 0) t = item.at;
    else {
      var key = (item && item.word) || firstWord(item && item.text != null ? item.text : text);
      if (key && this.words.length) t = this.find(key, this.cursor);
    }
    if (t == null) t = fallback;
    if (t > this.cursor) this.cursor = t + 0.01;
    return t;
  };
  /** A fallback time: `f` of the way through the clip (timeline seconds). */
  Timing.prototype.frac = function (f) { return this.t0 + this.dur * f; };
  /** The end of the VO word that starts at `s` (or s + d when none matches). */
  Timing.prototype.endOf = function (s, d) {
    for (var i = 0; i < this.words.length; i++) if (Math.abs(this.words[i].s - s) < 1e-6) return this.words[i].e;
    return s + (d == null ? 0.3 : d);
  };

  /** A sound cue at timeline time `t` (kinds: CONTRACT §9d; sound design maps kind -> a pack sound). */
  function cue(timing, t, kind, label, sound) {
    var local = t - timing.t0;
    if (!(local >= 0 && local <= timing.dur)) return;
    var list = window.__rcCues || (window.__rcCues = []);
    var c = { t: Math.round(local * 1000) / 1000, kind: kind };
    if (label) c.label = String(label).slice(0, 60);
    if (sound) c.sound = sound;
    list.push(c);
  }

  /**
   * Word captions from the voice-over timings. words = [{w, s, e}] in timeline seconds; keys = key words.
   * o = { y (centre line, px), size, color, key, glow (bool), font, weight, stretch, maxW, from, to }
   * Only words inside [from, to) (the clip's window) are built.
   */
  function Captions(stage, words, keys, o) {
    var self = this, u = RC.u;
    var keyset = {};
    (keys || []).forEach(function (k) { keyset[norm(k)] = 1; });
    var list = (words || []).filter(function (w) {
      return w && typeof w.w === "string" && typeof w.s === "number" && (o.from == null || w.s >= o.from - 0.05) && (o.to == null || w.s < o.to);
    });
    this.o = o; this.chunks = [];
    var cur = null;
    list.forEach(function (w, i) {
      var prev = list[i - 1];
      var prevEnd = prev ? (typeof prev.e === "number" && prev.e > prev.s ? prev.e : prev.s + 0.3) : 0;
      var brk = !cur || cur.words.length >= 3 || (prev && (/[.,?!;:]$/.test(prev.w) || w.s - prevEnd > 0.35));
      var we = typeof w.e === "number" && w.e > w.s ? w.e : w.s + 0.3;
      if (brk) { cur = { words: [], s: w.s, e: we }; self.chunks.push(cur); }
      cur.words.push(w); cur.e = we;
    });
    this.chunks.forEach(function (c, ci) {
      var line = RC.el("div", { style: { position: "absolute", left: "0", width: RC.width + "px", textAlign: "center", whiteSpace: "nowrap",
        fontFamily: o.font || "Archivo", fontWeight: String(o.weight || 700), fontStretch: (o.stretch || 100) + "%",
        fontSize: (o.size || 58) * u + "px", letterSpacing: "-0.005em", lineHeight: "1", opacity: "0" } });
      c.spans = c.words.map(function (w, wi) {
        var key = !!keyset[norm(w.w)];
        var span = RC.el("span", { text: w.w, style: { display: "inline-block", marginRight: wi < c.words.length - 1 ? 0.28 + "em" : "0",
          color: key ? o.key : o.color, transformOrigin: "50% 80%" } });
        span._key = key; span._s = w.s;
        line.appendChild(span);
        return span;
      });
      stage.appendChild(line);
      RC.fitText(line, o.maxW || RC.width - RC.safe.left - RC.safe.right, (o.size || 58) * u, 30 * u);
      line.style.top = (o.y - line.offsetHeight / 2) + "px";
      c.line = line;
      var next = self.chunks[ci + 1];
      // off exactly when the next chunk comes on (it shows 0.03 s before its first word): never two chunks at once
      c.until = next ? Math.min(next.s - 0.03, c.e + 0.6) : c.e + 0.6;
    });
  }
  Captions.prototype.render = function (g, fade) {
    var o = this.o, u = RC.u;
    this.chunks.forEach(function (c) {
      var on = g >= c.s - 0.03 && g < c.until;
      c.line.style.opacity = on ? String(fade == null ? 1 : fade) : "0";
      if (!on) return;
      c.spans.forEach(function (sp) {
        var p = RC.progress(g, sp._s - 0.03, 0.12, "snappy");
        RC.set(sp, { y: (1 - p) * 14 * u, scale: 0.9 + 0.1 * p, opacity: p });
        if (sp._key && o.glow) sp.style.textShadow = "0 0 " + 16 * u + "px " + RC.alpha(o.key, 0.8) + ", 0 " + 4 * u + "px " + 16 * u + "px rgba(0,0,0,.6)";
        else sp.style.textShadow = o.glow ? "0 " + 4 * u + "px " + 16 * u + "px rgba(0,0,0,.6)" : "none";
      });
    });
  };
  /** The standard caption line of a piece (when P.captions and words are given), else a no-op. */
  function captionsFor(stage, P, timing, o) {
    if (!P.captions || !(P.words && P.words.length)) return { render: function () {} };
    var base = { y: 1440 * RC.u, size: 64, color: BONE, key: P.accent, glow: true, from: timing.t0, to: timing.end };
    return new Captions(stage, P.words, P.keys, Object.assign(base, o || {}));
  }

  /** Full-frame canvas behind the DOM layers. */
  function canvas(stage) {
    var c = RC.el("canvas", { width: RC.width, height: RC.height, style: { position: "absolute", left: "0", top: "0", width: RC.width + "px", height: RC.height + "px" } });
    stage.appendChild(c);
    return c;
  }
  /** Big display word (extended caps). */
  function big(stage, text, px, extra) {
    var n = RC.el("div", { text: text, style: Object.assign({ position: "absolute", left: "0", top: "0", whiteSpace: "nowrap",
      fontFamily: "Archivo", fontWeight: "900", fontStretch: "125%", textTransform: "uppercase", letterSpacing: "-0.01em",
      lineHeight: "0.92", color: BONE, fontSize: px + "px" }, extra || {}) });
    stage.appendChild(n);
    return n;
  }
  function mono(stage, text, px, extra) {
    var n = RC.el("div", { text: text, style: Object.assign({ position: "absolute", left: "0", top: "0", whiteSpace: "pre",
      fontFamily: "JetBrains Mono", fontWeight: "600", color: BONE, fontSize: px + "px", lineHeight: "1.3" }, extra || {}) });
    stage.appendChild(n);
    return n;
  }
  /** A mono pill with an accent outline (kickers, tags). */
  function pill(stage, text, px, accent, extra) {
    var u = RC.u;
    return mono(stage, text, px, Object.assign({ fontWeight: "800", letterSpacing: ".2em", padding: 12 * u + "px " + 26 * u + "px",
      border: 2 * u + "px solid " + accent, borderRadius: "999px", color: BONE, background: "rgba(7,7,10,.6)" }, extra || {}));
  }
  /** Centre a node horizontally at y (top). */
  function centre(node, y) { node.style.left = (RC.width - node.offsetWidth) / 2 + "px"; node.style.top = y + "px"; }
  /** Pop-in (scale + fade) of a pill or tag at timeline time s. */
  function pop(node, g, s) {
    var k = RC.progress(g, s, 0.35, "bouncy");
    RC.set(node, { scale: 0.7 + 0.3 * k, opacity: clamp(k * 1.5, 0, 1) });
  }
  /** Typed text: the first n characters of `full` between from and to (timeline s). */
  function typed(full, g, from, to) {
    var n = Math.floor(clamp((g - from) / Math.max(0.05, to - from), 0, 1) * full.length);
    return full.slice(0, n);
  }
  /**
   * Code syntax colours for one line: [[text, colour], …]. Comments fog, keywords dim bone, `name` (the function the
   * piece is about) in the accent, everything else bone. Language-neutral enough for JS / Python / pseudo-code.
   */
  var KEYWORDS = /^(const|let|var|function|return|if|else|for|while|def|import|from|new|class|async|await|end|then|lambda)$/;
  function highlight(line, name, accent) {
    var out = [];
    var text = String(line == null ? "" : line);
    var cut = text.search(/\/\/|#(?![0-9a-fA-F]{3,8}\b)/);
    var code = cut >= 0 ? text.slice(0, cut) : text;
    var comment = cut >= 0 ? text.slice(cut) : "";
    var parts = code.split(/([A-Za-z_][A-Za-z0-9_]*)/);
    parts.forEach(function (p) {
      if (!p) return;
      var colour = BONE;
      if (KEYWORDS.test(p)) colour = "rgba(242,238,230,.55)";
      else if (name && p === name) colour = accent;
      var last = out[out.length - 1];
      if (last && last[1] === colour) last[0] += p; else out.push([p, colour]);
    });
    if (comment) out.push([comment, FOG]);
    if (!out.length) out.push(["", BONE]);
    return out;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  return { BONE: BONE, INK: INK, FOG: FOG, clamp: clamp, sstep: sstep, Camera: Camera, backdrop: backdrop, vignette: vignette,
    drawGrid: drawGrid, drawSolid: drawSolid, ignite: ignite, reveal: reveal, Captions: Captions, captionsFor: captionsFor,
    canvas: canvas, big: big, mono: mono, pill: pill, centre: centre, pop: pop, typed: typed, highlight: highlight,
    norm: norm, numberWord: numberWord, firstWord: firstWord, Timing: Timing, cue: cue, pad2: pad2 };
})();
