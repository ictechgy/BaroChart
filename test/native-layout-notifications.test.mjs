// Host wiring checks only; the optional Swift runner executes actual observers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const swift=readFileSync(new URL('../native/AsterNative.swift',import.meta.url),'utf8'),java=readFileSync(new URL('../native/android/java/dev/aster/charts/AsterEngine.java',import.meta.url),'utf8');

test('Swift validates layout no-op receipts before observer notification',()=>{
 const order=swift.split('} else if operation == "setPanelOrder" {')[1]?.split('} else if operation == "setIndicatorPlacement" {')[0];
 assert.ok(order);assert.match(order,/result.isBoolean/);assert.match(order,/if result.toBool\(\) \{notifyChanges\(\)\}/);
 const placement=swift.split('} else if operation == "setIndicatorPlacement" {')[1]?.split('} else if operation == "translateDrawings" {')[0];
 assert.ok(placement);for(const text of ['result.isObject','changed.isNumber','count.isFinite','count.rounded(.towardZero)==count','count>=0,count<=256','if count>0 {notifyChanges()}'])assert.ok(placement.includes(text),text);
});

test('Java routes layout results through strict change classifiers',()=>{
 const order=java.split('}else if("setPanelOrder".equals(operation)){')[1]?.split('}else if("setIndicatorPlacement".equals(operation)){')[0];
 assert.ok(order);assert.match(order,/LayoutReceipt.panelOrder\(result\)/);
 const placement=java.split('}else if("setIndicatorPlacement".equals(operation)){')[1]?.split('}else if("translateDrawings".equals(operation)){')[0];
 assert.ok(placement);assert.match(placement,/result instanceof JSONObject/);assert.match(placement,/LayoutReceipt.indicatorPlacement\(\(\(JSONObject\)result\).get\("changed"\)\)/);
});
