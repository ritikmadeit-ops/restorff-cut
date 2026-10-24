const hs = []; for (let i = 0; i <= 20; i++) hs.push(+(100 + i * 0.05).toFixed(2)); hs.push(388.891, 454.359, 200.25, 200.75, 201.25);
const html = '<style>.c{position:absolute;left:300px;top:300px;width:200px;transform:translate(-50%,-50%)}</style>' + hs.map((h, i) => `<div id="e${i}" class="c" style="height:${h}px"></div>`).join("");
export default [
  { name: "centring-fine", html, code: `return ${JSON.stringify(hs)}.map((h, i) => { const el = document.getElementById("e" + i); const f = new DOMMatrix(getComputedStyle(el).transform).f; gsap.set(el, { rotation: "+=0" }); return h + " off=" + el.offsetHeight + " f=" + f + " -> yP=" + gsap.getProperty(el, "yPercent") + " y=" + (+gsap.getProperty(el, "y")).toFixed(4); });` },
];
