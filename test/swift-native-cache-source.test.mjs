import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const uiKit = readFileSync(new URL('../native/AsterUIKit.swift', import.meta.url), 'utf8');

test('UIKit memory warning handler uses purge wiring (source-only; UIKit runtime unavailable)', () => {
  assert.match(uiKit, /AsterNativeCacheBudget\.shared\.purge\(\)/);
  assert.doesNotMatch(uiKit, /AsterNativeCacheBudget\.shared\.setLimit\(0\)/);
  const warning = uiKit.slice(uiKit.indexOf('didReceiveMemoryWarningNotification'), uiKit.indexOf('synchronizeFont();setNeedsDisplay()'));
  assert.match(warning, /AsterNativeCacheBudget\.shared\.purge\(\)/);
  assert.doesNotMatch(warning, /frameRenderer\s*=\s*nil/);
});

test('UIKit font restoration avoids pointer cancellation during dispose (source-only)', () => {
  const start = uiKit.indexOf('private func restoreFont');
  const end = uiKit.indexOf('private func refreshAccessibility', start);
  assert.ok(start >= 0 && end > start);
  const restoreFont = uiKit.slice(start, end);
  assert.match(restoreFont, /if !disposing \{cancelInteraction\(clearCrosshair: false\)\}/);
});
