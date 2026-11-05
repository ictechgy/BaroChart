// Renderer-only Canvas submission. Chart business state is supplied as commands.
export function renderCanvas(ctx, scene, dpr = 1) {
  drawCanvasCommands(ctx, scene, dpr, true);
}
export function drawCanvasCommands(ctx, scene, dpr, clear) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); if (clear) {ctx.clearRect(0,0,scene.width,scene.height);ctx.fillStyle = scene.background; ctx.fillRect(0, 0, scene.width, scene.height);}
  for (const c of scene.commands) {
    ctx.save(); if (c.clip) {ctx.beginPath(); ctx.rect(...c.clip); ctx.clip();}
    ctx.strokeStyle = c.color; ctx.fillStyle = c.fill ?? c.color; ctx.lineWidth = c.width ?? 1; if (c.dash) ctx.setLineDash(c.dash);
    if (c.op === 'lines') {ctx.beginPath(); for (let i = 0; i < c.coords.length; i += 4) {ctx.moveTo(c.coords[i], c.coords[i + 1]); ctx.lineTo(c.coords[i + 2], c.coords[i + 3]);} ctx.stroke();}
    else if (c.op === 'rects') {ctx.beginPath(); for (let i = 0; i < c.coords.length; i += 4) ctx.rect(...c.coords.slice(i, i + 4)); ctx.fill();}
    else if (c.op === 'path') {ctx.beginPath(); c.points.forEach((v, i) => {if (!(i % 2)) (i ? ctx.lineTo : ctx.moveTo).call(ctx, v, c.points[i + 1]);}); ctx.stroke(); if (c.fill && c.points.length) {ctx.lineTo(c.points[c.points.length - 2], c.baseline); ctx.lineTo(c.points[0], c.baseline); ctx.closePath(); ctx.fill();}}
    else if (c.op === 'box') {if (c.fill) ctx.fillRect(c.x, c.y, c.w, c.h); ctx.strokeRect(c.x, c.y, c.w, c.h);}
    else if (c.op === 'ellipse') {ctx.beginPath(); ctx.ellipse(c.x + c.w / 2, c.y + c.h / 2, c.w / 2, c.h / 2, 0, 0, Math.PI * 2); if (c.fill) ctx.fill(); ctx.stroke();}
    else if (c.op === 'text') {ctx.font = c.font ?? '12px monospace'; ctx.fillStyle = c.color; ctx.fillText(c.text, c.x, c.y);}
    ctx.restore();
  }
}
