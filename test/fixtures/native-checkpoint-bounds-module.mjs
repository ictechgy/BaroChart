import {defineIndicatorModule} from '../../src/core/indicator-modules.mjs';

// Static, trusted test module: its payload is deliberately generic so the
// native record's structural and byte limits are tested independently of EMA.
export const checkpointProbe = {calls: 0, lastState: null, lastParams: null, mutateHistory: false, onValidate: null};
export const checkpointFixtureName = 'test.native-checkpoint-bounds@1/payload';
function factory() {
  return {outputs: ['value'], create() {
    let index = 0;
    return {step(bar) {index++; return [bar.close];}, snapshot: () => ({index, payload: null}), restore(state) {index = state.index;}};
  }};
}
function validateCheckpoint(params, state, index) {
  checkpointProbe.calls++;
  checkpointProbe.lastState = state;
  checkpointProbe.lastParams = params;
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      Object.keys(state).length !== 2 || !Object.hasOwn(state, 'payload') || state.index !== index) {
    throw new TypeError('Fixture checkpoint shape or index');
  }
  checkpointProbe.onValidate?.(state, index);
  if (checkpointProbe.mutateHistory || params.mode === 'mutate') state.index++;
  if (params.mode === 'hidden') Object.defineProperty(state, 'hidden', {value: 1});
  if (params.mode === 'symbol') state[Symbol('hidden')] = 1;
  if (params.mode === 'reject') return false;
  if (params.mode === 'replace') return {...state};
  if (params.mode === 'async') return Promise.resolve(true);
  if (params.mode === 'throw') throw new TypeError('Fixture checkpoint rejected');
  return state;
}
defineIndicatorModule({id: 'test.native-checkpoint-bounds', version: 1, stateVersion: 1, indicators: {
  payload: {factory, validateCheckpoint, causal: true},
}});
