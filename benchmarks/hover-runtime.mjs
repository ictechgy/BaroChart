// Browser fixture, serialized by hover.mjs. Importing this module does no work.
export async function hoverRuntime(config) {
  const A = await import('/src/index.mjs');
  const root = document.getElementById('root');
  const nativeRAF = globalThis.requestAnimationFrame.bind(globalThis);
  const nativeCreateElement = document.createElement.bind(document);
  const canvasRefs = [], errors = [], glBuffers = new Map(), glTextures = new Map(), glRenderbuffers = new Map();
  const renderbufferAllocations = [];
  let activeRAF = null, activeDraw = null, activeCalls = null, pending = null, completed = null;
  let chart = null, model = null, store = null, host = null, phase = 'idle';
  let heartbeat = null, heartbeatStart = 0, lastBeat = 0, heartbeatSamples = [];
  const counts = {bufferData: 0, bufferSubData: 0, texImage2D: 0, drawArraysInstanced: 0, drawElementsInstanced: 0,
    drawArrays: 0, drawElements: 0, blitFramebuffer: 0, renderbufferStorage: 0, renderbufferStorageMultisample: 0,
    bufferAllocationBytes: 0, bufferUploadBytes: 0, textureAllocationBytes: 0, textureUploadBytes: 0,
    renderbufferAllocationRGBAEquivalentBytes: 0, bufferDeletes: 0, textureDeletes: 0, renderbufferDeletes: 0};
  const patches = [];
  const bytesOf = value => ArrayBuffer.isView(value) ? value.byteLength : value instanceof ArrayBuffer ? value.byteLength : 0;
  const add = (key, amount = 1) => {counts[key] += amount; if (activeCalls) activeCalls[key] = (activeCalls[key] ?? 0) + amount;};
  const patch = (object, key, replacement) => {const original = object[key]; object[key] = replacement(original); patches.push(() => {object[key] = original;});};
  patch(document, 'createElement', original => function (...args) {
    const element = original.apply(this, args);
    if (String(args[0]).toLowerCase() === 'canvas') canvasRefs.push(new WeakRef(element));
    return element;
  });
  if (globalThis.OffscreenCanvas) patch(globalThis, 'OffscreenCanvas', Original => class extends Original {
    constructor(...args) {super(...args); canvasRefs.push(new WeakRef(this));}
  });
  patch(globalThis, 'requestAnimationFrame', original => function (callback) {
    return original.call(this, timestamp => {
      const previous = activeRAF;
      activeRAF = {timestamp, callbackEnteredAt: performance.now()};
      try {return callback(timestamp);} finally {activeRAF = previous;}
    });
  });
  const GL = globalThis.WebGL2RenderingContext?.prototype;
  if(config.profile) patch(CanvasRenderingContext2D.prototype,'drawImage',original=>function(...args){
    const begin=performance.now();try{return original.apply(this,args);}finally{
      if(activeDraw){const p=activeDraw.profile;p.canvasCopySubmitMs+=performance.now()-begin;p.canvasCopies++;p.canvasCopiedPixelBytes+=(args[0]?.width??0)*(args[0]?.height??0)*4;}
    }
  });
  if (GL) {
    patch(GL, 'bufferData', original => function (target, data, ...rest) {
      const bytes = typeof data === 'number' ? data : bytesOf(data), result = original.call(this, target, data, ...rest);
      const buffer = this.getParameter(target === this.ARRAY_BUFFER ? this.ARRAY_BUFFER_BINDING : this.ELEMENT_ARRAY_BUFFER_BINDING);
      glBuffers.set(buffer, bytes); add('bufferData'); add('bufferAllocationBytes', bytes);
      if (typeof data !== 'number') add('bufferUploadBytes', bytes); return result;
    });
    patch(GL, 'bufferSubData', original => function (target, offset, data, ...rest) {
      const result = original.call(this, target, offset, data, ...rest);
      add('bufferSubData'); add('bufferUploadBytes', bytesOf(data)); return result;
    });
    patch(GL, 'texImage2D', original => function (...args) {
      const result = original.apply(this, args), source = args.length === 6 ? args[5] : null;
      const width = source?.width ?? args[3], height = source?.height ?? args[4], bytes = width * height * 4;
      glTextures.set(this.getParameter(this.TEXTURE_BINDING_2D), bytes);
      add('texImage2D'); add('textureAllocationBytes', bytes);
      if (source || args[8] !== null) add('textureUploadBytes', bytes); return result;
    });
    for (const name of ['drawArraysInstanced', 'drawElementsInstanced', 'drawArrays', 'drawElements', 'blitFramebuffer']) {
      patch(GL, name, original => function (...args) {const result = original.apply(this, args); add(name); return result;});
    }
    for (const name of ['renderbufferStorage', 'renderbufferStorageMultisample']) {
      patch(GL, name, original => function (...args) {
        const result = original.apply(this, args), multisample = name === 'renderbufferStorageMultisample';
        const requestedSamples = multisample ? args[1] : 0, internalFormat = args[multisample ? 2 : 1];
        const width = args[multisample ? 3 : 2], height = args[multisample ? 4 : 3];
        const actualSamples = this.getRenderbufferParameter(this.RENDERBUFFER, this.RENDERBUFFER_SAMPLES);
        const buffer = this.getParameter(this.RENDERBUFFER_BINDING);
        const allocation = {requestedSamples, actualSamples, width, height, internalFormat,
          rgbaEquivalentBytes: width * height * 4 * Math.max(1, actualSamples),
          rgba8: internalFormat === this.RGBA8};
        glRenderbuffers.set(buffer, allocation); renderbufferAllocations.push(allocation);
        add(name); add('renderbufferAllocationRGBAEquivalentBytes', allocation.rgbaEquivalentBytes); return result;
      });
    }
    patch(GL, 'deleteBuffer', original => function (buffer) {
      const result = original.call(this, buffer); glBuffers.delete(buffer); add('bufferDeletes'); return result;
    });
    patch(GL, 'deleteTexture', original => function (texture) {
      const result = original.call(this, texture); glTextures.delete(texture); add('textureDeletes'); return result;
    });
    patch(GL, 'deleteRenderbuffer', original => function (buffer) {
      const result = original.call(this, buffer); glRenderbuffers.delete(buffer); add('renderbufferDeletes'); return result;
    });
  }
  const sum = values => values.reduce((total, value) => total + value, 0);
  const nextFrame = () => new Promise(resolve => nativeRAF(resolve));
  async function settle() {await nextFrame(); await nextFrame();}
  function startHeartbeat() {
    if (heartbeat !== null) throw new Error('Heartbeat already running');
    heartbeatStart = lastBeat = performance.now(); heartbeatSamples = [];
    heartbeat = setInterval(() => {const now = performance.now(); heartbeatSamples.push({from: lastBeat, to: now, gapMs: now - lastBeat, final: false}); lastBeat = now;}, config.heartbeatMs);
  }
  function stopHeartbeat() {
    const now = performance.now(); clearInterval(heartbeat); heartbeat = null;
    // This final interval includes a last blocking operation even when the timer
    // has not had an opportunity to fire before the measurement ends.
    heartbeatSamples.push({from: lastBeat, to: now, gapMs: now - lastBeat, final: true});
    return {requestedIntervalMs: config.heartbeatMs, begin: heartbeatStart, end: now, raw: heartbeatSamples};
  }
  function readback() {
    const begin = performance.now();
    if (chart.renderer?.gl) {
      const gl = chart.renderer.gl;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    } else chart.ctx.getImageData(0, 0, 1, 1);
    return {begin, end: performance.now()};
  }
  function onPointer(event) {
    if (phase !== 'pointer' || !pending) return;
    if (pending.event) throw new Error('Multiple pointer events for one sample');
    pending.event = {captureAt: performance.now(), timeStamp: event.timeStamp, isTrusted: event.isTrusted,
      pointerType: event.pointerType, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY};
  }
  function onRender() {
    if (!activeDraw) return;
    activeDraw.renderEventAt = performance.now();
    activeDraw.chartTimingMs = chart.timings.at(-1);
    if (phase !== 'pointer' || !pending?.event) return;
    const event = pending.event, draw = activeDraw, read = readback();
    completed = {index: pending.index, point: pending.point, event, raf: draw.raf,
      renderEventAt: draw.renderEventAt, drawBegin: draw.begin, renderBegin: draw.renderBegin,
      renderEnd: draw.renderEnd, readbackBegin: read.begin, readbackEnd: read.end,
      pointerToRenderMs: draw.renderEventAt - event.timeStamp,
      pointerHandlerToRenderMs: draw.renderEventAt - event.captureAt,
      eventTimeStampToRenderMs: draw.renderEventAt - event.timeStamp,
      queuedInputMs: event.captureAt - event.timeStamp,
      rafWaitMs: draw.raf ? draw.raf.callbackEnteredAt - event.captureAt : null,
      eventToRafMs: draw.raf ? draw.raf.callbackEnteredAt - event.timeStamp : null,
      drawNowCpuSubmitMs: draw.renderEventAt - draw.begin,
      rendererCpuSubmitMs: draw.renderEnd - draw.renderBegin,
      drawAndReadbackMs: read.end - draw.begin,
      pointerToReadbackMs: read.end - event.timeStamp,
      pointerHandlerToReadbackMs: read.end - event.captureAt,
      readbackMs: read.end - read.begin, chartTimingMs: draw.chartTimingMs,
      glCalls: {...activeCalls}, renderMethods: [...draw.renderMethods],
      ...(config.profile?{profile:{...draw.profile},renderMetrics:{...chart.renderMetrics}}:{}),
      crosshair: model.crosshair ? {...model.crosshair} : null,
      stats: {...chart.lastScene.stats}, rendererKind: chart.rendererKind};
  }
  function ledger() {
    const canvases = canvasRefs.map(ref => ref.deref()).filter(Boolean);
    const pixels = canvases.map(canvas => ({width: canvas.width, height: canvas.height,
      attached: !!canvas.isConnected, rgbaEquivalentBytes: canvas.width * canvas.height * 4}));
    const lineValuesBytes = sum(model.series.filter(series => series.values).map(series => series.values.byteLength));
    const lineIndexBytes = sum(model.series.filter(series => series.values).map(series => model.seriesData(series).index.bytes));
    const columnBytes = sum(Object.values(store.columns).map(column => column.byteLength));
    return {storeBytes: store.bytes, columnBytes, storeIndexBytes: store.bytes - columnBytes,
      alignedLineValuesBytes: lineValuesBytes, alignedLineRangeIndexBytes: lineIndexBytes,
      rendererPackingBytes: chart.renderer?.packed?.byteLength ?? 0,
      knownCpuTypedArrayBytes: store.bytes + lineValuesBytes + lineIndexBytes + (chart.renderer?.packed?.byteLength ?? 0),
      canvases: pixels, canvasCount: pixels.length, attachedCanvases: document.querySelectorAll('canvas').length,
      canvasRGBAEquivalentBytes: sum(pixels.map(pixel => pixel.rgbaEquivalentBytes)),
      liveAllocatedGLBufferBytes: sum([...glBuffers.values()]), liveAllocatedGLTextureBytes: sum([...glTextures.values()]),
      liveAllocatedGLRenderbufferRGBAEquivalentBytes: sum([...glRenderbuffers.values()].map(buffer => buffer.rgbaEquivalentBytes)),
      liveAllocatedGLRenderbuffers: glRenderbuffers.size, renderbufferAllocations: [...renderbufferAllocations],
      observedDrawCalls: counts.drawArraysInstanced + counts.drawElementsInstanced + counts.drawArrays + counts.drawElements,
      storeSubscriptions: store.listeners.size, modelDisposed: !!model.disposed, chartDisposed: !!chart.disposed,
      cumulativeGLCalls: {...counts}};
  }
  host = nativeCreateElement('div'); host.style.cssText = `width:${config.width}px;height:${config.height}px;`; root.append(host);
  store = new A.BarStore(); store.setColumns(A.seededColumns(config.bars, config.seed));
  model = new A.ChartModel({store, visibleBars: 200}); model.addSeries({id: 'price', type: 'candles', panel: 'price'});
  for (let index = 0; index < config.lineSeries; index++) model.addSeries({id: 'line' + index, type: 'line', panel: 'price',
    values: Float64Array.from(store.columns.close.subarray(0, store.length), value => value + (index - 16) * .1),
    color: index % 2 ? '#f5b85a' : '#aa91f7'});
  if (config.range === 'full-100k') model.fit();
  chart = A.createChart(host, model, {renderer: config.renderer, dpr: () => config.dpr, observeResize: false,
    ...(config.layerCaching===null||config.layerCaching===undefined?{}:{layerCaching:config.layerCaching}),
    onError: error => errors.push(error.message), onFallback: reason => errors.push('Fallback: ' + reason)});
  if (chart.rendererKind !== config.renderer) throw new Error('Requested renderer unavailable: ' + chart.rendererKind);
  chart.canvas.addEventListener('pointermove', onPointer, {capture: true});
  chart.canvas.addEventListener('aster:render', onRender);
  const originalDraw = chart.drawNow;
  if(config.profile&&chart.sceneCache?.frame)patch(chart.sceneCache,'frame',original=>function(...args){const begin=performance.now();try{return original.apply(this,args);}finally{if(activeDraw)activeDraw.profile.sceneCacheCpuMs+=performance.now()-begin;}});
  // Optional renderer entry points are observed if present. Frozen 0.2.4 needs
  // only renderScene; chart.timings and drawNow total remain authoritative.
  for (const method of ['renderScene', 'renderLayers']) if (typeof chart[method] === 'function') {
    const original = chart[method];
    chart[method] = function (...args) {
      const draw = activeDraw;
      if (draw) {
        if (!draw.renderDepth) draw.renderBegin ??= performance.now();
        draw.renderDepth++; if (!draw.renderMethods.includes(method)) draw.renderMethods.push(method);
      }
      try {return original.apply(this, args);} finally {
        if (draw && --draw.renderDepth === 0) draw.renderEnd = performance.now();
      }
    };
  }
  chart.drawNow = function (...args) {
    activeDraw = {begin: performance.now(), raf: activeRAF ? {...activeRAF} : null, renderDepth: 0, renderMethods: [],profile:{sceneCacheCpuMs:0,canvasCopySubmitMs:0,canvasCopies:0,canvasCopiedPixelBytes:0}}; activeCalls = {};
    try {return originalDraw.apply(this, args);} finally {
      activeDraw.end = performance.now(); activeDraw.glCalls = {...activeCalls}; this.__hoverLastDraw = activeDraw;
      activeDraw = null; activeCalls = null;
      if (completed && pending?.resolve) {const row = completed; completed = null; pending.resolve(row); pending = null;}
    }
  };
  await settle();
  const initialView = {...model.view};
  let gl = chart.renderer?.gl, debug = gl?.getExtension('WEBGL_debug_renderer_info');
  const environment = {userAgent: navigator.userAgent, dpr: devicePixelRatio,
    gpu: gl ? {vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      version: gl.getParameter(gl.VERSION), antialias: gl.getContextAttributes().antialias, maxSamples: gl.getParameter(gl.MAX_SAMPLES),
      timerExtension: !!gl.getExtension('EXT_disjoint_timer_query_webgl2')} : null};
  globalThis.__asterHover = {
    environment,
    ready: () => ({stats: {...chart.lastScene.stats}, view: {...model.view}, ledger: ledger(), errors: [...errors]}),
    async microbenchmark() {
      const results = [];
      for (const crosshair of [false, true]) {
        model.crosshair = crosshair ? {x: 600, y: 350} : null;
        for (const operation of ['buildScene', 'drawNow']) {
          phase = 'micro'; const raw = [];
          for (let index = 0; index < config.warmup; index++) {
            if (operation === 'buildScene') A.buildScene(model, config.width, config.height);
            else {chart.drawNow(); readback();}
          }
          await settle(); startHeartbeat();
          for (let index = 0; index < config.samples; index++) {
            const begin = performance.now();
            if (operation === 'buildScene') {
              const scene = A.buildScene(model, config.width, config.height);
              const end = performance.now(); raw.push({index, begin, end, cpuMs: end - begin, stats: {...scene.stats}});
            } else {
              chart.drawNow(); const returnedAt = performance.now(), draw = chart.__hoverLastDraw, read = readback();
              raw.push({index, begin, end: returnedAt, cpuMs: returnedAt - begin,
                chartTimingMs: draw.chartTimingMs, rendererCpuSubmitMs: draw.renderEnd - draw.renderBegin,
                drawAndReadbackMs: read.end - begin, readbackMs: read.end - read.begin,
                glCalls: {...draw.glCalls}, renderMethods: [...draw.renderMethods], stats: {...chart.lastScene.stats}});
              if(config.profile)raw.at(-1).profile={...draw.profile};
            }
          }
          results.push({operation, crosshair, raw, heartbeat: stopHeartbeat()}); phase = 'idle'; await settle();
        }
      }
      return results;
    },
    async beginPointers() {model.crosshair = null; chart.drawNow(); await settle(); phase = 'pointer'; startHeartbeat(); return true;},
    armPointer(index, point) {
      if (pending) throw new Error('Pointer sample already armed');
      let resolve; const promise = new Promise(done => {resolve = done;});
      pending = {index, point, resolve, promise}; this.pointerPromise = promise;
      const rect = chart.canvas.getBoundingClientRect(); return {x: rect.left + point.x, y: rect.top + point.y};
    },
    waitPointer: function () {return this.pointerPromise;},
    endPointers() {phase = 'idle'; return {heartbeat: stopHeartbeat(), stats: {...chart.lastScene.stats}, view: {...model.view},
      unchangedView: JSON.stringify(model.view) === JSON.stringify(initialView), errors: [...errors], ledger: ledger()};},
    ledger,
    destroy() {
      if (heartbeat !== null) stopHeartbeat();
      chart.canvas.removeEventListener('pointermove', onPointer, {capture: true});
      chart.canvas.removeEventListener('aster:render', onRender);
      const renderer = chart.renderer;
      chart.destroy({disposeModel: true});
      const cleanup = {canvases: document.querySelectorAll('canvas').length, storeSubscriptions: store.listeners.size,
        modelDisposed: !!model.disposed, chartDisposed: !!chart.disposed, framePending: chart.frame !== null,
        chartListeners: chart.listeners.length, rendererDisposed: renderer ? !!renderer.disposed : null,
        liveAllocatedGLBufferBytes: sum([...glBuffers.values()]), liveAllocatedGLTextureBytes: sum([...glTextures.values()]),
        liveAllocatedGLRenderbufferRGBAEquivalentBytes: sum([...glRenderbuffers.values()].map(buffer => buffer.rgbaEquivalentBytes)),
        liveAllocatedGLRenderbuffers: glRenderbuffers.size,
        cumulativeGLCalls: {...counts}};
      patches.reverse().forEach(restore => restore());
      chart = null; model = null; store = null; gl = null; debug = null; host.remove(); host = null;
      canvasRefs.length = 0; glBuffers.clear(); glTextures.clear(); glRenderbuffers.clear(); this.pointerPromise = null; pending = null; completed = null;
      return cleanup;
    }
  };
}
