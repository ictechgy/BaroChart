// Minimal deterministic Node host. Canvas methods are no-ops; this is NOT
// raster/browser/ResizeObserver scheduling evidence.
export function modeledChartDOM() {
  const keys = ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const frames = new Map(), observers = new Set(); let serial = 0, rasterCalls = 0;
  const context = Object.fromEntries(['setTransform', 'clearRect', 'fillRect', 'save', 'restore', 'beginPath', 'rect', 'clip', 'setLineDash',
    'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'strokeRect', 'ellipse', 'fillText', 'drawImage'].map(key => [key, () => {rasterCalls++;}]));
  class Element extends EventTarget {
    constructor(tag) {super(); this.tagName = tag; this.style = {}; this.children = []; this.parentNode = null; this.width = 300; this.height = 150; this.clientWidth = 640; this.clientHeight = 280;}
    append(child) {child.remove(); this.children.push(child); child.parentNode = this;}
    remove() {if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null;}
    setAttribute() {} focus() {} setPointerCapture() {}
    getBoundingClientRect() {return {left: 0, top: 0, width: this.clientWidth, height: this.clientHeight};}
    getContext(kind) {if (kind !== '2d') throw Error('Modeled host supports Canvas only'); return context;}
    querySelectorAll(tag) {return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]);}
  }
  const root = new Element('main');
  globalThis.document = {createElement: tag => new Element(tag), getElementById: id => {if (id !== 'root') throw Error('Unknown fixture root'); return root;}};
  globalThis.requestAnimationFrame = callback => {frames.set(++serial, callback); return serial;};
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class {observe() {observers.add(this);} unobserve() {} disconnect() {observers.delete(this);}};
  return {root, frames, observers, get rasterCalls() {return rasterCalls;},
    async settle() {for (let i = 0; frames.size; i++) {if (i >= 20) throw Error('Modeled RAF failed to quiesce'); const batch = [...frames];
      for (const [id, callback] of batch) {if (!frames.delete(id)) continue; callback(i);} await Promise.resolve();}},
    restore() {for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}
  };
}
