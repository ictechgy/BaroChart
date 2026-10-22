// Run against buildNativeBundle({modulePaths: ['test/fixtures/native-workspace-module.mjs']}).
// Trusted locally linked factory reentry only; no host/SDK cancellation is modeled.
// Run each nativePrepareConstructionScenario in a fresh runtime, including on failure.
// The tiny two-bar model needs neither symbol formatting nor an Intl shim.
(function () {
  const scenarios = [
    'ordinary admission and finish',
    'nested workspace create is busy',
    'nested params create is busy',
    'nested prepare create is busy',
    'nested async create is busy',
    'factory throw releases reservation',
    'workspace disposal cannot release construction reservation',
    'params disposal cannot release construction reservation',
    'unrelated disposal preserves admitted transfer',
  ];
  const fields = ['time', 'open', 'high', 'low', 'close', 'volume'];
  const bars = [
    {time: 1700000000000, open: 100, high: 103, low: 99, close: 102, volume: 11},
    {time: 1700000060000, open: 102, high: 105, low: 101, close: 104, volume: 13},
  ];
  const probe = globalThis.nativeWorkspaceProbe;
  if (!probe) throw new Error('The trusted native-workspace fixture module must be linked');
  function attempt(fn) {
    try {return {returned: true, value: fn()};}
    catch (error) {return {returned: false, error: String(error.message)};}
  }
  function run(name) {
    const assertions = [], observations = {};
    const check = (condition, label, detail) => assertions.push({label, passed: !!condition, ...(detail === undefined ? {} : {detail})});
    const record = (label, fn) => (observations[label] = attempt(fn));
    const busy = (result, label) => check(!result.returned && /busy/.test(result.error), label, result);
    const missing = label => {
      const result = record(label, () => {nativeAsyncTargetBuffer(0, 0, 1); return true;});
      check(!result.returned && /missing/.test(result.error), label, result);
    };
    const sourceStore = new Aster.BarStore([], {maxBars: 16});
    sourceStore.setColumns(Object.fromEntries(fields.map(field => [field, new Float64Array(bars.map(bar => bar[field]))])));
    const sourceModel = new Aster.ChartModel({store: sourceStore});
    const sourceAPI = new Aster.ChartAPI(sourceModel);
    let prepare, capture;
    probe.onFactory = null;
    try {
      sourceAPI.addIndicator('probe', 'test.native-workspace@1/pair', {shift: 0});
      sourceAPI.indicatorValues('probe');
      const size = {width: 800, height: 500};
      prepare = new Aster.PrepareCapture(sourceModel, {kind: 'columns', length: 2});
      const prepareMetadata = prepare.metadataJSON, prepareUI = prepare.ui(null, size);
      prepare.release();
      capture = new Aster.AsyncCapture(sourceModel, {kind: 'correction', bar: {...sourceStore.at(0), volume: 17}});
      const asyncMetadata = capture.metadataJSON;
      capture.release();
      const binding = {key: 'prepare-construction:tiny', revision: '1', adjustmentVersion: '1', priceUnit: 'USD', adjustment: 'raw'};
      const workspaceMetadata = Aster.safeCheckpointStringify({schema: 'aster.native-workspace-target', version: 1,
        document: Aster.saveWorkspace(sourceAPI, binding), datasetBinding: binding,
        source: {length: 2, maxBars: sourceStore.maxBars, timeframeMs: sourceStore.timeframeMs,
          timeOrigin: sourceStore.timeOrigin, version: sourceStore.version, timeVersion: sourceStore.timeVersion},
        size, retainedBytes: 4096, maxBytes: 805306368});
      const paramsMetadata = Aster.safeCheckpointStringify({schema: 'aster.native-params-target', version: 1,
        registration: 7, id: 'ema', name: 'ema', params: {period: 2}, length: 2, capacity: 16,
        outputs: ['value'], plotOffsets: {}, maxBytes: 805306368});
      const create = () => nativePrepareCreate(prepareMetadata);
      const creators = {workspace: () => nativeWorkspaceTargetCreate(workspaceMetadata),
        params: () => nativeParamsTargetCreate(paramsMetadata), prepare: create,
        async: () => nativeAsyncCreate(asyncMetadata)};
      const disposers = {workspace: () => nativeWorkspaceTargetDispose(), params: () => nativeParamsTargetDispose()};
      function once(fn) {
        probe.onFactory = () => {probe.onFactory = null; observations.factoryCallbacks = (observations.factoryCallbacks ?? 0) + 1; fn();};
      }
      function finish(firstView) {
        const first = firstView ?? nativeAsyncTargetBuffer(0, 0, 1);
        first[0] = bars[0].time;
        const second = nativeAsyncTargetBuffer(0, 1, 1);
        check(second.buffer === first.buffer, 'outer time buffer identity and transfer cursor are preserved');
        second[0] = bars[1].time;
        for (let slot = 1; slot < fields.length; slot++) nativeAsyncTargetBuffer(slot, 0, 2).set(sourceStore.columns[fields[slot]].subarray(0, 2));
        check(nativeAsyncStart() === true, 'shared start reaches the fully transferred outer prepare');
        let complete = false;
        for (let i = 0; i < 128; i++) if (JSON.parse(nativeAsyncStep(2)).complete) {complete = true; break;}
        check(complete, 'two-bar preparation terminates');
        check(nativeAsyncFinish(prepareUI) === true, 'outer prepare finishes through its legacy bridge');
        check(nativeModel.store !== sourceStore && nativeModel.store.length === 2, 'finished target owns a distinct two-bar store');
        const entry = nativeModel.indicators.get('probe');
        observations.finished = {bars: [nativeModel.store.at(0), nativeModel.store.at(1)],
          outputs: {value: Array.from(entry.outputs.value.slice(0, 2)), toString: Array.from(entry.outputs.toString.slice(0, 2))}};
        check(fields.every(field => bars.every((bar, i) => observations.finished.bars[i][field] === bar[field])), 'finished prepare preserves every copied OHLCV field');
        check(observations.finished.outputs.value[0] === 102 && observations.finished.outputs.value[1] === 104 &&
          observations.finished.outputs.toString[0] === 103 && observations.finished.outputs.toString[1] === 105,
          'finished linked indicator matches fixed two-output oracle');
        missing('finish releases the reachable target buffer');
      }
      if (name === 'ordinary admission and finish') {
        check(create() === true, 'ordinary prepare admission succeeds');
        for (const kind of Object.keys(creators)) busy(record('duplicate ' + kind, creators[kind]), 'admitted prepare blocks sequential ' + kind);
        finish();
      } else if (/^nested /.test(name)) {
        const kind = name.split(' ')[1];
        let nestedView;
        once(() => {
          record('nestedCreate', creators[kind]);
          const access = record('bufferDuringConstruction', () => {
            nestedView = nativeAsyncTargetBuffer(0, 0, 1);
            nestedView[0] = bars[0].time;
            return true;
          });
          check(!access.returned && /missing/.test(access.error), 'constructor reservation exposes no nested target buffer', access);
        });
        const outer = record('outerCreate', create);
        check(observations.factoryCallbacks === 1, 'trusted factory runs exactly once during outer construction');
        busy(observations.nestedCreate, 'nested ' + kind + ' admission is busy');
        check(outer.returned && outer.value === true, 'outer prepare retains admission');
        // Diagnose baseline corruption before cleanup; never treat recovery as success.
        if (nestedView) {
          const continued = record('continueWronglyAcceptedTransfer', () => {
            const next = nativeAsyncTargetBuffer(0, 1, 1);
            observations.acceptedBufferStillRouted = next.buffer === nestedView.buffer;
            next[0] = bars[1].time;
            return true;
          });
          if (kind === 'params' && continued.returned) {
            for (let slot = 1; slot < fields.length; slot++) nativeAsyncTargetBuffer(slot, 0, 2).set(sourceStore.columns[fields[slot]].subarray(0, 2));
            record('startAfterWronglyRoutedTransfer', () => nativeAsyncStart());
            // Params has its own disposal API. Remove only this wrongly admitted
            // diagnostic target so the independent outer-output checks can run.
            record('disposeWronglyAcceptedParams', disposers.params);
          }
          check(false, 'construction must not accept a nested transfer that is overwritten or routed separately', continued);
        }
        if (outer.returned) finish();
      } else if (name === 'factory throw releases reservation') {
        once(() => {throw new Error('fixture prepare factory exception');});
        const rejected = record('throwingCreate', create);
        check(observations.factoryCallbacks === 1, 'throwing linked factory executes during construction');
        check(!rejected.returned && rejected.error === 'fixture prepare factory exception', 'factory exception is preserved', rejected);
        missing('throwing constructor has no target buffer');
        check(nativeWorkspaceTargetDispose() === false && nativeParamsTargetDispose() === false, 'failed prepare leaves no unrelated target owner');
        check(create() === true, 'fresh prepare is admitted after factory failure');
        finish();
        // PreparedData checks series after its linked definitions have run.
        // Exercise finally-style release when construction fails after reentry.
        const invalid = JSON.parse(prepareMetadata);
        invalid.series = null;
        once(() => {observations.postFactoryReached = true;});
        const late = record('postFactoryFailure', () => nativePrepareCreate(JSON.stringify(invalid)));
        check(observations.postFactoryReached === true && observations.factoryCallbacks === 2,
          'late-failure constructor reaches the actual linked factory');
        check(!late.returned && late.error === 'Prepare series', 'post-factory validation exception is preserved', late);
        missing('post-factory failure has no target buffer');
        check(create() === true, 'fresh prepare is admitted after post-factory failure');
        finish();
      } else if (/ disposal cannot release construction reservation$/.test(name)) {
        const kind = name.split(' ')[0];
        once(() => {
          record('unrelatedDispose', disposers[kind]);
          record('createAfterUnrelatedDispose', create);
        });
        const outer = record('outerCreate', create);
        check(observations.factoryCallbacks === 1, 'trusted factory executes during reserved construction');
        check(observations.unrelatedDispose.returned && observations.unrelatedDispose.value === false,
          kind + ' disposal does not claim the prepare construction owner', observations.unrelatedDispose);
        busy(observations.createAfterUnrelatedDispose, 'unrelated disposal does not release the prepare reservation');
        check(outer.returned && outer.value === true, 'outer prepare survives unrelated disposal');
        finish();
      } else if (name === 'unrelated disposal preserves admitted transfer') {
        check(create() === true, 'ordinary prepare admission succeeds');
        const first = nativeAsyncTargetBuffer(0, 0, 1);
        first[0] = bars[0].time;
        for (const kind of Object.keys(disposers)) {
          const result = record(kind + 'Dispose', disposers[kind]);
          check(result.returned && result.value === false, kind + ' disposal leaves admitted prepare unchanged', result);
          busy(record('createAfter ' + kind + 'Dispose', create), kind + ' disposal does not release admitted prepare');
        }
        finish(first);
      } else throw new Error('Unknown construction scenario: ' + name);
      check(sourceModel.disposed !== true && sourceStore.length === 2 && fields.every(field => bars.every((bar, i) => sourceStore.at(i)[field] === bar[field])),
        'source model remains live with unchanged bars');
    } catch (error) {
      check(false, 'scenario completes without unexpected exception', String(error.message));
    } finally {
      probe.onFactory = null;
      attempt(() => nativeParamsTargetDispose());
      attempt(() => nativeWorkspaceTargetDispose());
      globalThis.nativeModel?.dispose();
      for (const key of ['nativeModel', 'nativeAPI', 'nativeInput', 'nativeSize']) delete globalThis[key];
      prepare?.release(); capture?.release(); sourceModel.dispose();
      check(sourceStore.listeners.size === 0, 'source cleanup removes store listeners');
    }
    return {scenario: name, passed: assertions.every(row => row.passed), checks: assertions.length, assertions, observations};
  }
  const requested = globalThis.nativePrepareConstructionScenario;
  const results = (requested === undefined ? scenarios : [requested]).map(run);
  return JSON.stringify({case: 'native-prepare-target-construction', passed: results.every(row => row.passed),
    scope: 'trusted locally linked prepare construction admission and isolated target finish only; no SDK or host cancellation execution; no heap-leak claim',
    modeledUTC: false, results});
})();
