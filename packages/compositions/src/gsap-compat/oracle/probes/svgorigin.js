const svg = '<svg width="400" height="300" viewBox="0 0 400 300"><rect id="r" x="20" y="30" width="100" height="40" style="transform-origin: center center"/><rect id="q" x="20" y="30" width="100" height="40" style="transform-origin: 10px 5px"/><rect id="b" x="20" y="30" width="100" height="40" style="transform-box: fill-box; transform-origin: center"/><rect id="z" x="20" y="30" width="100" height="40" style="transform-origin: 50% 50%"/></svg>';
export default [
  { name: "svg-css-origin", html: svg, code: 'gsap.set(["#r","#q","#b","#z"],{rotation:90}); return ["r","q","b","z"].map(id=>{const e=document.getElementById(id); return e.getAttribute("transform")+" | "+e.style.transformOrigin+" | "+getComputedStyle(e).transformOrigin;});' },
];
