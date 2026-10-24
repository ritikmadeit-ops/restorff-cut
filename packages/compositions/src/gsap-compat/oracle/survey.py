"""Survey the GSAP API surface used by HyperFrames registry blocks and components (anim-runtime, 2026-10-24).

Reads only the blocks' and components' own HTML/JS (never any vendored gsap*.js file).
Usage: py -I survey.py <hyperframes-root> <out.json>
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = sys.argv[1]
OUT = sys.argv[2]

SKIP_FILE = re.compile(r"(gsap[^/]*\.js$|\.min\.js$|\.iife\.js$|RoomEnvironment\.js$|BufferGeometryUtils\.js$)", re.I)


def unit_files(kind):
    base = os.path.join(ROOT, "registry", kind)
    for name in sorted(os.listdir(base)):
        d = os.path.join(base, name)
        if not os.path.isdir(d):
            continue
        files = []
        for dp, dn, fn in os.walk(d):
            dn[:] = [x for x in dn if x not in ("node_modules", "source")]
            for f in fn:
                if not re.search(r"\.(html|js|mjs)$", f):
                    continue
                p = os.path.join(dp, f)
                if SKIP_FILE.search(p.replace("\\", "/")):
                    continue
                files.append(p)
        yield name, files


def read(p):
    with open(p, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def split_args(src, i):
    """src[i] == '(' ; return (list of top-level arg strings, end index)."""
    depth = 0
    args = []
    cur = []
    j = i
    n = len(src)
    while j < n:
        c = src[j]
        if c in "\"'`":
            q = c
            k = j + 1
            while k < n and src[k] != q:
                if src[k] == "\\":
                    k += 1
                k += 1
            cur.append(src[j:k + 1])
            j = k + 1
            continue
        if src.startswith("//", j):
            k = src.find("\n", j)
            j = n if k < 0 else k
            continue
        if src.startswith("/*", j):
            k = src.find("*/", j)
            j = n if k < 0 else k + 2
            continue
        if c in "([{":
            depth += 1
            if depth == 1 and c == "(":
                j += 1
                continue
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                args.append("".join(cur).strip())
                return args, j
        elif c == "," and depth == 1:
            args.append("".join(cur).strip())
            cur = []
            j += 1
            continue
        cur.append(c)
        j += 1
    return args, j


def classify_pos(a):
    a = a.strip()
    if a == "":
        return "none"
    if re.fullmatch(r"-?\d+(\.\d+)?", a):
        return "number"
    m = re.fullmatch(r"([\"'`])(.*)\1", a, re.S)
    if m:
        s = m.group(2).strip()
        if s == "<":
            return '"<"'
        if s == ">":
            return '">"'
        if re.fullmatch(r"<[+-]?=?-?[\d.]+", s):
            return '"<offset" (e.g. "<0.2", "<-0.1")'
        if re.fullmatch(r">[+-]?=?-?[\d.]+", s):
            return '">offset"'
        if re.fullmatch(r"\+=-?[\d.]+", s):
            return '"+=n"'
        if re.fullmatch(r"-=[\d.]+", s):
            return '"-=n"'
        if re.fullmatch(r"[<>]?[+-]=?[\d.]+%", s) or "%" in s:
            return "percent form"
        if re.fullmatch(r"[A-Za-z_$][\w$-]*", s):
            return "label"
        if re.fullmatch(r"[A-Za-z_$][\w$-]*\s*[+-]=\s*-?[\d.]+", s):
            return "label+=n / label-=n"
        if "${" in s:
            return "template string"
        return "other string: " + s[:20]
    if re.fullmatch(r"[A-Za-z_$][\w$.]*", a):
        return "identifier/expression"
    return "expression"


SURFACE = {
    "gsap_methods": re.compile(r"\bgsap\.([a-zA-Z]+)\b"),
    "utils": re.compile(r"\bgsap\.utils\.([a-zA-Z]+)\b"),
}
TL_METHODS = ["to", "from", "fromTo", "set", "add", "addLabel", "call", "addPause", "removeLabel", "duration",
              "totalDuration", "seek", "progress", "totalProgress", "time", "totalTime", "timeScale", "repeat",
              "repeatDelay", "yoyo", "pause", "play", "paused", "kill", "clear", "getChildren", "tweenTo",
              "tweenFromTo", "eventCallback", "invalidate", "reverse", "restart", "then", "getTweensOf",
              "shiftChildren", "endTime", "startTime", "delay", "recent", "labels", "isActive", "iteration",
              "resume", "nextLabel", "previousLabel", "currentLabel", "render", "revert", "getById", "vars",
              "targets", "remove", "addPause", "reversed"]
VAR_KEYS = ["x", "y", "z", "xPercent", "yPercent", "scale", "scaleX", "scaleY", "scaleZ", "rotation", "rotate",
            "rotationX", "rotationY", "rotationZ", "rotateX", "rotateY", "rotateZ", "skewX", "skewY", "skew",
            "opacity", "autoAlpha", "transformOrigin", "svgOrigin", "transformPerspective", "perspective",
            "filter", "clipPath", "webkitClipPath", "backgroundColor", "background", "backgroundPosition",
            "backgroundSize", "color", "borderColor", "fill", "stroke", "attr", "strokeDashoffset",
            "strokeDasharray", "strokeWidth", "width", "height", "top", "left", "right", "bottom", "margin",
            "padding", "borderRadius", "boxShadow", "textShadow", "fontSize", "letterSpacing", "lineHeight",
            "fontWeight", "fontVariationSettings", "visibility", "display", "zIndex", "innerText", "textContent",
            "motionPath", "drawSVG", "morphSVG", "text", "scrambleText", "onUpdate", "onComplete", "onStart",
            "onRepeat", "onReverseComplete", "onUpdateParams", "onCompleteParams", "stagger", "ease", "delay",
            "repeat", "yoyo", "repeatDelay", "yoyoEase", "keyframes", "immediateRender", "overwrite", "force3D",
            "smoothOrigin", "modifiers", "snap", "roundProps", "runBackwards", "paused", "startAt", "data", "id",
            "callbackScope", "inherit", "lazy", "duration", "defaults", "css", "physics2D", "inertia",
            "maskPosition", "mask", "webkitMask", "objectPosition", "outline", "inset", "translate",
            "transform", "maxWidth", "maxHeight", "minWidth", "gridTemplateColumns", "flex", "gap",
            "backdropFilter", "WebkitBackdropFilter", "borderWidth", "outlineOffset", "wordSpacing",
            "strokeOpacity", "fillOpacity", "stopColor", "r", "cx", "cy", "d", "points", "offsetDistance"]
PLUGINS = ["SplitText", "DrawSVGPlugin", "MorphSVGPlugin", "MotionPathPlugin", "ScrambleTextPlugin", "TextPlugin",
           "CustomEase", "CustomWiggle", "CustomBounce", "Flip", "Physics2DPlugin", "PhysicsPropsPlugin",
           "InertiaPlugin", "ScrollTrigger", "ScrollToPlugin", "Observer", "Draggable", "EasePack", "PixiPlugin",
           "EaselPlugin", "CSSRulePlugin", "MotionPathHelper", "GSDevTools", "ScrollSmoother", "RoughEase",
           "SlowMo", "ExpoScaleEase"]
PLUGIN_PROPS = {"drawSVG": r"\bdrawSVG\s*:", "morphSVG": r"\bmorphSVG\s*:", "motionPath": r"\bmotionPath\s*:",
                "scrambleText": r"\bscrambleText\s*:", "physics2D": r"\bphysics2D\s*:"}
EASE_RE = re.compile(r"""\b(?:ease|yoyoEase)\s*:\s*(["'`])([^"'`]*)\1""")
EASE_LIT = re.compile(r"""(["'])((?:power[0-4]|back|elastic|bounce|expo|sine|circ|quad|cubic|quart|quint|strong|linear|none|steps|rough|slow|expoScale|custom)[\w.]*(?:\([^)]*\))?)\1""")
LEGACY_EASE = re.compile(r"\b(Power[0-4]|Back|Elastic|Bounce|Expo|Sine|Circ|Linear|Quad|Cubic|Quart|Quint|Strong)\.(ease\w+)")
STAGGER_RE = re.compile(r"\bstagger\s*:\s*([^,}\n]+)")
REGISTER_RE = re.compile(r"__timelines\s*\[")
LIB_RE = {
    "three": re.compile(r"\bTHREE\.|from\s+[\"']three|three(\.module|\.core)?(\.min)?\.js|three@"),
    "lottie": re.compile(r"\blottie\b|__hfLottie|dotlottie", re.I),
    "anime": re.compile(r"\banime\s*\(|animejs|anime\.js|__hfAnime|createTimeline\s*\("),
    "d3": re.compile(r"\bd3\.|d3@"),
    "webgpu": re.compile(r"data-requires-webgpu|shaders\.iife\.js|navigator\.gpu"),
    "canvas2d": re.compile(r"getContext\(\s*[\"']2d"),
    "webgl": re.compile(r"getContext\(\s*[\"']webgl"),
    "hf-seek event": re.compile(r"hf-seek"),
    "css @keyframes": re.compile(r"@keyframes"),
    "WAAPI .animate(": re.compile(r"\.animate\(\s*\["),
    "__hyperframes.getVariables": re.compile(r"__hyperframes\.getVariables|getVariables\(\)"),
    "__hyperframes.fitTextFontSize": re.compile(r"fitTextFontSize"),
    "requestAnimationFrame": re.compile(r"requestAnimationFrame"),
    "Math.random": re.compile(r"Math\.random"),
    "Date.now/performance.now": re.compile(r"Date\.now|performance\.now|new Date\("),
    "setTimeout/setInterval": re.compile(r"setTimeout|setInterval"),
    "data-composition-src (nested)": re.compile(r"data-composition-src"),
    "window.__hf.buildReady": re.compile(r"buildReady"),
    "document.fonts.ready": re.compile(r"fonts\.ready"),
}

report = {}
for kind in ("blocks", "components"):
    units = 0
    gsap_units = 0
    unit_feat = defaultdict(Counter)  # feature group -> Counter(name -> number of units using it)
    occ = defaultdict(Counter)  # feature group -> Counter(name -> occurrences)
    gsap_unit_names = []
    lib_units = defaultdict(list)
    for name, files in unit_files(kind):
        units += 1
        src = "\n".join(read(p) for p in files)
        seen = defaultdict(set)

        def hit(group, key, n=1):
            occ[group][key] += n
            seen[group].add(key)

        for lib, rx in LIB_RE.items():
            if rx.search(src):
                lib_units[lib].append(name)
        uses_gsap = bool(re.search(r"\bgsap\.", src))
        if not uses_gsap:
            continue
        gsap_units += 1
        gsap_unit_names.append(name)
        for m in SURFACE["gsap_methods"].finditer(src):
            hit("gsap.<method>", m.group(1))
        for m in SURFACE["utils"].finditer(src):
            hit("gsap.utils.<fn>", m.group(1))
        for meth in TL_METHODS:
            for m in re.finditer(r"\.\s*" + meth + r"\s*\(", src):
                # skip gsap.<method>( which is counted above
                before = src[max(0, m.start() - 4):m.start()]
                if before.endswith("gsap"):
                    continue
                hit("instance .<method>(", meth)
        for key in VAR_KEYS:
            n = len(re.findall(r"[{,\s]" + re.escape(key) + r"\s*:", src))
            if n:
                hit("vars key", key, n)
        for m in re.finditer(r"[{,\s][\"'](--[\w-]+)[\"']\s*:", src):
            hit("vars key", "CSS variable '--x'")
        for p in PLUGINS:
            n = len(re.findall(r"\b" + p + r"\b", src))
            if n:
                hit("plugin (name mentioned)", p, n)
        for p, rx in PLUGIN_PROPS.items():
            n = len(re.findall(rx, src))
            if n:
                hit("plugin vars key", p, n)
        for m in re.finditer(r"registerPlugin\(([^)]*)\)", src):
            for a in m.group(1).split(","):
                a = a.strip()
                if a:
                    hit("registerPlugin(arg)", a)
        eases = Counter()
        for m in EASE_RE.finditer(src):
            eases[m.group(2).strip()] += 1
        for m in EASE_LIT.finditer(src):
            if m.group(2) not in eases:
                pass
        for e, n in eases.items():
            fam = re.sub(r"\(.*\)", "(…)", e)
            hit("ease string", fam, n)
            base = e.split(".")[0].split("(")[0]
            hit("ease family", base, n)
        for m in re.finditer(r"\bease\s*:\s*([A-Za-z_$][\w$.]*)\s*[,}\n]", src):
            hit("ease non-literal", "identifier/expression")
        for m in LEGACY_EASE.finditer(src):
            hit("ease family", "legacy " + m.group(1) + "." + m.group(2))
        for m in STAGGER_RE.finditer(src):
            v = m.group(1).strip()
            if v.startswith("{"):
                body = src[m.start(1):m.start(1) + 300]
                body = body[:body.find("}") + 1] if "}" in body else body
                keys = re.findall(r"(\w+)\s*:", body)
                hit("stagger form", "object")
                for k in keys:
                    hit("stagger object key", k)
                fm = re.search(r"from\s*:\s*([\"']?[\w-]+[\"']?|\[[^\]]*\])", body)
                if fm:
                    hit("stagger from", fm.group(1))
            elif re.fullmatch(r"-?[\d.]+", v):
                hit("stagger form", "number")
            elif v.startswith("function") or "=>" in v:
                hit("stagger form", "function")
            else:
                hit("stagger form", "identifier/expression")
        n = len(REGISTER_RE.findall(src))
        if n:
            hit("registration", "window.__timelines[...] =", n)
        # position parameter of timeline calls
        for meth, idx in (("to", 2), ("from", 2), ("fromTo", 3), ("set", 2), ("add", 1), ("call", 3), ("addLabel", 1)):
            for m in re.finditer(r"(?<!gsap)\.\s*" + meth + r"\s*\(", src):
                i = src.find("(", m.start())
                args, _ = split_args(src, i)
                if not args or args == [""]:
                    continue
                if len(args) > idx:
                    cls = classify_pos(args[idx])
                else:
                    cls = "omitted (appends at end)"
                hit("position (." + meth + ")", cls)
                hit("position (all)", cls)
        for g, keys in seen.items():
            for k in keys:
                unit_feat[g][k] += 1
    report[kind] = {
        "units": units,
        "gsap_units": gsap_units,
        "gsap_unit_names": gsap_unit_names,
        "libs": {k: {"count": len(v), "names": v} for k, v in lib_units.items()},
        "features": {g: {k: {"units": unit_feat[g][k], "occurrences": occ[g][k]} for k in sorted(occ[g], key=lambda x: -occ[g][x])} for g in occ},
    }

with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=1)
for kind in report:
    r = report[kind]
    print(kind, "units", r["units"], "gsap", r["gsap_units"])
    for lib, v in r["libs"].items():
        print("  lib", lib, v["count"])
