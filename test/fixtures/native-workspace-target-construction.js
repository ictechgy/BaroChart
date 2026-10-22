// Run against buildNativeBundle({modulePaths: ['test/fixtures/native-workspace-module.mjs']}).
// This is trusted, locally linked factory callback reentry, not a remote-input exploit.
// No Intl shim is needed: the tiny workspace has no symbol or timezone formatting.
// Set nativeWorkspaceConstructionScenario to run one case in a fresh runtime.
(function () {
  const scenarios = [
    'ordinary admission and recovery',
    'nested workspace create is busy',
    'nested async create is busy',
    'nested prepared create is busy',
    'nested params create is busy',
    'dispose during construction cancels outer',
    'factory throw releases reservation',
    'cancelled outer preserves workspace replacement',
    'cancelled outer preserves params replacement',
    'post-construction vacancy failure releases reservation',
    'cleanup exception releases reservation',
    'cleanup exception preserves workspace replacement',
  ];
  const fields = ['time', 'open', 'high', 'low', 'close', 'volume'];
  const moduleName = 'test.native-workspace@1/pair';
  const binding = {key: 'construction:tiny', revision: '1', adjustmentVersion: '1', priceUnit: 'USD', adjustment: 'raw'};
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
    const missing = label => {
      const result = record(label, () => nativeAsyncTargetBuffer(0, 0, 1));
      check(!result.returned && /missing/.test(result.error), label, result.error ?? 'buffer was available');
    };
    const sourceStore = new Aster.BarStore([], {maxBars: 16});
    sourceStore.setColumns(Aster.seededColumns(2, 17));
    const sourceModel = new Aster.ChartModel({store: sourceStore});
    const sourceAPI = new Aster.ChartAPI(sourceModel);
    let oldDispose = null;
    probe.onFactory = null;
    try {
      sourceAPI.addIndicator('probe', moduleName, {shift: 2});
      const document = Aster.saveWorkspace(sourceAPI, binding);
      const metadata = Aster.safeCheckpointStringify({schema: 'aster.native-workspace-target', version: 1,
        document, datasetBinding: binding,
        source: {length: 2, maxBars: sourceStore.maxBars, timeframeMs: sourceStore.timeframeMs,
          timeOrigin: sourceStore.timeOrigin, version: sourceStore.version, timeVersion: sourceStore.timeVersion},
        size: {width: 800, height: 500}, retainedBytes: 4096, maxBytes: 805306368});
      const paramsMetadata = Aster.safeCheckpointStringify({schema: 'aster.native-params-target', version: 1,
        registration: 7, id: 'ema', name: 'ema', params: {period: 2}, length: 2, capacity: 16,
        outputs: ['value'], plotOffsets: {}, maxBytes: 805306368});
      const capture = new Aster.AsyncCapture(sourceModel, {kind: 'correction', bar: {...sourceStore.at(0), volume: 11}});
      const asyncMetadata = capture.metadataJSON;
      capture.release();
      const prepare = new Aster.PrepareCapture(sourceModel, {kind: 'columns', length: 2});
      const preparedMetadata = prepare.metadataJSON;
      prepare.release();
      const create = () => nativeWorkspaceTargetCreate(metadata);
      function once(fn) {
        probe.onFactory = () => {probe.onFactory = null; observations.factoryCallbacks = (observations.factoryCallbacks ?? 0) + 1; fn();};
      }
      function finishWorkspace(timeReceived = 0) {
        for (let slot = 0; slot < fields.length; slot++) {
          const offset = slot === 0 ? timeReceived : 0;
          if (offset < 2) nativeAsyncTargetBuffer(slot, offset, 2 - offset).set(sourceStore.columns[fields[slot]].subarray(offset, 2));
        }
        nativeAsyncStart();
        let complete = false;
        for (let i = 0; i < 256; i++) if (JSON.parse(nativeAsyncStep(2)).complete) {complete = true; break;}
        check(complete, 'tiny target preparation terminates');
        const receipt = nativeWorkspaceTargetFinish();
        check(receipt.status === 'target-ready' && receipt.hostPublished === false, 'only isolated target runtime becomes ready');
        check(nativeSaveWorkspace(binding) === document, 'published workspace equals original tiny document');
        check(nativeModel.store !== sourceStore, 'published workspace owns a distinct store');
        check(nativeModel.store.at(0).time === sourceStore.at(0).time && nativeModel.store.at(1).close === sourceStore.at(1).close,
          'published workspace preserves the two copied bars');
      }
      function recover() {
        const admission = record('freshAdmission', create);
        check(admission.returned && admission.value === true, 'fresh workspace admission succeeds after terminal construction');
        if (admission.returned) finishWorkspace();
      }
      function throwDuringCleanup() {
        // Narrow, restored injection on this wrapper's cleanup only. The original
        // cleanup runs first; no general prototype-hardening behavior is assumed.
        oldDispose = Aster.NativeWorkspacePrepared.prototype.dispose;
        Aster.NativeWorkspacePrepared.prototype.dispose = function () {
          observations.cleanupCalls = (observations.cleanupCalls ?? 0) + 1;
          oldDispose.call(this);
          observations.cleanedWrapperClosed = this.closed === true;
          observations.cleanedWrapperColumns = Object.keys(this.columns).length;
          throw new Error('fixture cleanup exception');
        };
      }
      function restoreCleanup() {
        if (oldDispose) {Aster.NativeWorkspacePrepared.prototype.dispose = oldDispose; oldDispose = null;}
      }
      if (name === 'ordinary admission and recovery') {
        check(create() === true, 'ordinary admission succeeds');
        const duplicate = record('duplicate', create);
        check(!duplicate.returned && /busy/.test(duplicate.error), 'sequential duplicate is busy');
        check(nativeWorkspaceTargetDispose() === true, 'admitted target is disposed');
        check(nativeWorkspaceTargetDispose() === false, 'disposal is idempotent');
        missing('disposed target has no buffer');
        recover();
      } else if (/^nested /.test(name)) {
        const kind = name.split(' ')[1];
        const nested = {workspace: create, async: () => nativeAsyncCreate(asyncMetadata),
          prepared: () => nativePrepareCreate(preparedMetadata), params: () => nativeParamsTargetCreate(paramsMetadata)}[kind];
        once(() => record('nestedCreate', nested));
        const outer = record('outerCreate', create);
        check(observations.factoryCallbacks === 1, 'trusted factory callback executes during construction');
        check(!observations.nestedCreate.returned && /busy/.test(observations.nestedCreate.error), 'nested ' + kind + ' target admission is busy', observations.nestedCreate);
        check(outer.returned && outer.value === true, 'outer workspace retains admission');
        if (kind === 'params' && observations.nestedCreate.returned) nativeParamsTargetDispose();
        if (outer.returned) finishWorkspace();
      } else if (name === 'dispose during construction cancels outer') {
        once(() => record('cancel', () => nativeWorkspaceTargetDispose()));
        const outer = record('outerCreate', create);
        check(observations.cancel.returned && observations.cancel.value === true, 'dispose acknowledges in-progress workspace owner', observations.cancel);
        check(!outer.returned && /cancelled/.test(outer.error), 'cancelled constructor cannot publish a target', outer);
        missing('cancelled constructor has no buffer');
        const leftover = nativeWorkspaceTargetDispose();
        check(leftover === false, 'cancelled constructor leaves no admitted workspace');
        recover();
      } else if (name === 'factory throw releases reservation') {
        once(() => {throw new Error('fixture factory exception');});
        const outer = record('outerCreate', create);
        check(!outer.returned && /fixture factory exception/.test(outer.error), 'factory exception is reported', outer);
        check(nativeWorkspaceTargetDispose() === false, 'throwing constructor leaves no workspace reservation');
        missing('throwing constructor has no buffer');
        recover();
      } else if (name === 'cancelled outer preserves workspace replacement' || name === 'cleanup exception preserves workspace replacement') {
        let replacementView;
        once(() => {
          record('cancel', () => nativeWorkspaceTargetDispose());
          record('replacementCreate', create);
          replacementView = nativeAsyncTargetBuffer(0, 0, 1);
          replacementView[0] = sourceStore.columns.time[0];
          if (name === 'cleanup exception preserves workspace replacement') throwDuringCleanup();
        });
        const outer = record('outerCreate', create);
        restoreCleanup();
        check(observations.cancel.returned && observations.cancel.value === true, 'dispose acknowledges original construction', observations.cancel);
        check(observations.replacementCreate.returned && observations.replacementCreate.value === true, 'replacement workspace is admitted after cancel');
        check(!outer.returned && /cancelled|fixture cleanup exception/.test(outer.error), 'stale outer constructor fails', outer);
        if (name === 'cleanup exception preserves workspace replacement') {
          check(observations.cleanupCalls === 1, 'stale outer cleanup is attempted exactly once');
          check(observations.cleanedWrapperClosed === true && observations.cleanedWrapperColumns === 0, 'original wrapper cleanup ran before injected exception');
        }
        const retained = record('replacementBuffer', () => {
          const view = nativeAsyncTargetBuffer(0, 1, 1);
          check(view.buffer === replacementView.buffer, 'replacement buffer identity survives stale outer completion');
          view[0] = sourceStore.columns.time[1];
          return true;
        });
        check(retained.returned, 'replacement transfer cursor survives stale outer completion', retained.error);
        if (retained.returned) finishWorkspace(2);
      } else if (name === 'cancelled outer preserves params replacement') {
        once(() => {
          record('cancel', () => nativeWorkspaceTargetDispose());
          record('replacementCreate', () => nativeParamsTargetCreate(paramsMetadata));
        });
        const outer = record('outerCreate', create);
        check(observations.cancel.returned && observations.cancel.value === true, 'dispose acknowledges original construction', observations.cancel);
        check(observations.replacementCreate.returned && observations.replacementCreate.value === true, 'params replacement is admitted after cancel');
        check(!outer.returned && /cancelled/.test(outer.error), 'stale outer constructor cannot coexist with params replacement', outer);
        for (let slot = 0; slot < fields.length; slot++) nativeAsyncTargetBuffer(slot, 0, 2).set(sourceStore.columns[fields[slot]].subarray(0, 2));
        nativeParamsTargetStart();
        let complete = false;
        for (let i = 0; i < 256; i++) if (nativeParamsTargetStep(2).complete) {complete = true; break;}
        check(complete, 'params replacement completes');
        check(JSON.parse(nativeParamsTargetDescriptor()).registration === 7, 'params replacement retains registration');
        check(nativeParamsTargetDispose() === true, 'params replacement remains disposable');
        missing('params replacement retirement leaves no stale workspace');
        nativeWorkspaceTargetDispose();
        recover();
      } else if (name === 'post-construction vacancy failure releases reservation' || name === 'cleanup exception releases reservation') {
        once(() => {
          globalThis.nativeSize = {width: 1, height: 1};
          if (name === 'cleanup exception releases reservation') throwDuringCleanup();
        });
        const outer = record('outerCreate', create);
        restoreCleanup();
        delete globalThis.nativeSize;
        check(!outer.returned && /isolated empty|fixture cleanup exception/.test(outer.error), 'post-construction vacancy violation rejects target', outer);
        if (name === 'cleanup exception releases reservation') {
          check(observations.cleanupCalls === 1, 'rejected candidate cleanup is attempted exactly once');
          check(observations.cleanedWrapperClosed === true && observations.cleanedWrapperColumns === 0, 'candidate releases its column references before injected exception');
        }
        check(nativeWorkspaceTargetDispose() === false, 'rejected candidate leaves no workspace reservation');
        missing('rejected candidate has no buffer');
        recover();
      } else throw new Error('Unknown construction scenario: ' + name);
      check(sourceModel.disposed !== true && sourceStore.length === 2, 'source model remains live and unchanged');
    } catch (error) {
      check(false, 'scenario completes without unexpected exception', String(error.message));
    } finally {
      probe.onFactory = null;
      if (oldDispose) Aster.NativeWorkspacePrepared.prototype.dispose = oldDispose;
      attempt(() => nativeParamsTargetDispose());
      attempt(() => nativeWorkspaceTargetDispose());
      globalThis.nativeModel?.dispose();
      for (const key of ['nativeModel', 'nativeAPI', 'nativeInput', 'nativeSize']) delete globalThis[key];
      sourceModel.dispose();
      check(sourceStore.listeners.size === 0, 'source cleanup removes store listeners');
    }
    // Observations contain scalars/receipts only; a held buffer is not a heap-leak measurement.
    for (const key of Object.keys(observations)) if (observations[key]?.value instanceof Float64Array) observations[key].value = 'Float64Array available';
    return {scenario: name, passed: assertions.every(row => row.passed), checks: assertions.length,
      assertions, observations};
  }
  const requested = globalThis.nativeWorkspaceConstructionScenario;
  const results = (requested === undefined ? scenarios : [requested]).map(run);
  return JSON.stringify({case: 'native-workspace-target-construction', passed: results.every(row => row.passed),
    scope: 'trusted locally linked factory construction ownership; isolated target only; no host publication or SDK execution; no heap-leak claim',
    modeledUTC: false, results});
})();
