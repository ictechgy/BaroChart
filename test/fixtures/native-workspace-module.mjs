import {defineIndicatorModule} from '../../src/core/indicator-modules.mjs';

// Linked by buildNativeBundle. All callbacks and data stay inside the target VM.
const probe = globalThis.nativeWorkspaceProbe = {
  factories: 0, creates: 0, steps: 0, snapshots: 0, checkpointChecks: 0,
  params: [], onFactory: null, onOutputs: null, failCreate: false,
};
function definition(params, outputs, offsets) {
  probe.factories++;
  probe.params.push({...params});
  probe.onFactory?.(params);
  return {
    get outputs() {probe.onOutputs?.(); return outputs;},
    plotOffsets: offsets,
    create() {
      probe.creates++;
      if (probe.failCreate) throw new Error('Fixture calculation unavailable');
      return {
        step(bar) {probe.steps++; return outputs.map((_, i) => bar.close + i);},
        snapshot() {probe.snapshots++; return 0;},
        restore(state) {if (state !== 0) throw new TypeError('Fixture checkpoint');},
      };
    },
  };
}
const validateCheckpoint = (_params, state) => {
  probe.checkpointChecks++;
  if (state !== 0) throw new TypeError('Fixture checkpoint');
};
defineIndicatorModule({id: 'test.native-workspace', version: 1, stateVersion: 3, indicators: {
  pair: {
    causal: true, validateCheckpoint,
    factory(params = {}) {
      const shift = params.shift ?? 2;
      return definition(params, ['value', 'toString'], {value: shift, toString: shift});
    },
  },
  wide: {
    causal: true, validateCheckpoint,
    factory(params = {}) {
      return definition(params, Array.from({length: 32}, (_, i) => 'value' + i), {});
    },
  },
}});
