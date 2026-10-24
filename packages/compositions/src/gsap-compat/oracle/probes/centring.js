const hs = [100, 101, 100.4, 100.6, 99.5, 99.4, 120.2, 77];
const html = '<style>.c{position:absolute;left:300px;top:300px;transform:translate(-50%,-50%)}</style>' + hs.map((h, i) => `<div id="e${i}" class="c" style="width:${h + 20}px;height:${h}px"></div>`).join("");
export default [
  { name: "centring-rule", html, code: `return ${JSON.stringify(hs)}.map((h, i) => { const el = document.getElementById("e" + i); const f = getComputedStyle(el).transform; gsap.set(el, { rotation: "+=0" }); return h + ":" + el.offsetHeight + ":" + f + " -> xP=" + gsap.getProperty(el, "xPercent") + " yP=" + gsap.getProperty(el, "yPercent") + " y=" + gsap.getProperty(el, "y"); });` },
];
