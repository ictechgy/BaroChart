// Host wiring source checks only. No Swift/JSC, Android, JNI or Handler execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        token => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
const swift = read('../native/AsterNative.swift');
const java = read('../native/android/java/dev/aster/charts/AsterEngine.java');
const flat = source => source.replace(/\s+/g, '');

// Match the requested declaration's balanced body, ignoring quoted braces and comments.
function body(source, pattern) {
    const match = pattern.exec(source);
    assert.ok(match, String(pattern));
    const structure = source.replace(/"(?:\\.|[^"\\])*"/g, token => ' '.repeat(token.length));
    let parentheses = 0, brackets = 0, start = -1;
    for (let index = match.index; index < structure.length; index++) {
        const character = structure[index];
        if (character === '(') parentheses++;
        else if (character === ')') parentheses--;
        else if (character === '[') brackets++;
        else if (character === ']') brackets--;
        else if (character === '{' && !parentheses && !brackets) { start = index; break; }
    }
    assert.ok(start >= 0, 'Body opening brace');
    let depth = 1, index = start + 1;
    for (; index < structure.length && depth; index++) {
        if (structure[index] === '{') depth++;
        else if (structure[index] === '}') depth--;
    }
    assert.equal(depth, 0, 'Balanced body');
    return source.slice(start + 1, index - 1);
}

function order(source, ...needles) {
    source = flat(source);
    let after = 0;
    for (const needle of needles) {
        const at = source.indexOf(flat(needle), after);
        assert.ok(at >= 0, needle);
        after = at + flat(needle).length;
    }
}

const swCommand = body(swift, /public func command\(/);
const jCommand = body(java, /public Object command\(/);
const swReceipt = body(swCommand, /if operation == "translateDrawings"/);
const jReceipt = body(jCommand, /if\("translateDrawings"\.equals\(operation\)\)\{/);
// Scope this extraction to the exact production nested class, not CompactionReceipt.changed.
const jDecoder = body(body(java, /static final class DrawingTranslationReceipt\b/), /static boolean changed\(/);

test('Swift static: thin drawing translation facade forwards raw deltas and IDs to ordinary command', () => {
    assert.match(flat(swift), /publicfunctranslateDrawings\(_ids:\[String\],deltaTimeMs:Double,deltaPrice:Double\)throws->\[String:Any\]/);
    assert.equal(flat(body(swift, /public func translateDrawings\(/)),
        'tryingestionCommand("translateDrawings",[ids,["deltaTimeMs":deltaTimeMs,"deltaPrice":deltaPrice]])');
    const forwarding = body(swift, /private func ingestionCommand\(/);
    order(forwarding, 'try command(operation,arguments)', '.toDictionary()',
        'else{throw AsterError.invalidScene}', 'return result');
});

test('Swift static: drawing translation retains owner/closed checks and the existing async policy', () => {
    order(swCommand, 'Thread.current === owner', '!closed', 'activeAsync', 'let result:JSValue',
        'call("nativeCommand",[operation,arguments])', 'if operation == "translateDrawings"');
    const asyncGate = swCommand.slice(0, swCommand.indexOf('let result:JSValue'));
    assert.match(flat(asyncGate), /activeWorkspace!=nil\|\|pendingWorkspaceRegistration/);
    assert.match(asyncGate, /"compactData"/);
    assert.doesNotMatch(asyncGate, /translateDrawings/);
    const dispatch = swCommand.slice(swCommand.indexOf('let result:JSValue'), swCommand.indexOf('if operation == "compactData"'));
    assert.doesNotMatch(dispatch, /translateDrawings/);
});

test('Swift static: changed is strictly numeric, finite and integral within 0 through 128', () => {
    order(swReceipt, 'result.isObject', 'let changed=result.forProperty("changed")',
        'changed.isNumber', 'throw AsterError.invalidScene', 'changed.toDouble()',
        'count.isFinite', 'count.rounded(.towardZero)==count', 'count>=0', 'count<=128',
        'throw AsterError.invalidScene', 'if count>0 {notifyChanges()}');
    assert.deepEqual([...swReceipt.matchAll(/forProperty\("([^"]+)"\)/g)].map(match => match[1]), ['changed']);
    assert.doesNotMatch(swReceipt, /removed|toString|toBool|\?\?/);
});

test('Swift static: zero changed bypasses both targeted and generic mutation notifications', () => {
    assert.equal((swReceipt.match(/notifyChanges\(\)/g) || []).length, 1);
    assert.match(flat(swCommand), /\}elseifoperation=="translateDrawings"\{/);
    const after = swCommand.slice(swCommand.indexOf('if operation == "translateDrawings"'));
    assert.match(flat(after), /ifcount>0\{notifyChanges\(\)\}\}elseifoperation=="setDrawingsStyle"/);
    assert.match(flat(after), /returnresult$/);
});

test('Swift static: retained observer error channel stays bounded', () => {
    const notify = body(swift, /fileprivate func notifyChanges\(/);
    assert.match(flat(notify), /observerErrors.count<32/);
    assert.match(notify, /onObserverError/);
});

test('Java static: thin drawing translation facade returns the ordinary command receipt', () => {
    assert.match(flat(java), /publicJSONObjecttranslateDrawings\(JSONArrayids,doubledeltaTimeMs,doubledeltaPrice\)throwsJSONException/);
    assert.equal(flat(body(java, /public JSONObject translateDrawings\(/)),
        'JSONObjectoptions=newJSONObject().put("deltaTimeMs",deltaTimeMs).put("deltaPrice",deltaPrice);return(JSONObject)command("translateDrawings",ids,options);');
});

test('Java static: drawing translation retains owner/closed checks without adding an async BUSY gate', () => {
    order(jCommand, 'check();', 'if(ingestionCommand(operation))',
        'invoke("nativeCommand",operation,new JSONArray(args))', 'if("translateDrawings".equals(operation))');
    const ownerCheck = body(java, /private void check\(/);
    order(ownerCheck, 'Thread.currentThread()!=owner', 'throw new IllegalStateException',
        'if(handle==0)', 'throw new IllegalStateException');
    assert.doesNotMatch(jCommand.slice(0, jCommand.indexOf('if("compactData".equals(operation)){')), /translateDrawings/);
    assert.doesNotMatch(body(java, /private static boolean ingestionCommand\(/), /translateDrawings/);
    const asyncOwner = body(java, /private void checkAsyncOwner\(/);
    order(asyncOwner, 'check();', 'Looper.myLooper()!=Looper.getMainLooper()', 'throw new IllegalStateException');
});

test('Java static: receipt object and required changed field are validated before notification', () => {
    order(jReceipt, 'result instanceof JSONObject', 'throw new JSONException',
        'DrawingTranslationReceipt.changed(((JSONObject)result).get("changed"))', 'notifyChanges()');
    assert.deepEqual([...jReceipt.matchAll(/\.get\("([^"]+)"\)/g)].map(match => match[1]), ['changed']);
    assert.doesNotMatch(jReceipt, /removed|CompactionReceipt|optInt|getInt|getDouble|parseDouble|\.has\(/);
    assert.equal((jReceipt.match(/notifyChanges\(\)/g) || []).length, 1);
});

test('Java static: zero changed bypasses generic mutation notification', () => {
    assert.match(flat(jCommand), /\}elseif\("translateDrawings"\.equals\(operation\)\)\{/);
    const after = jCommand.slice(jCommand.indexOf('if("translateDrawings".equals(operation))'));
    assert.match(flat(after), /if\(DrawingTranslationReceipt.changed\(\(\(JSONObject\)result\).get\("changed"\)\)\)notifyChanges\(\);\}elseif\("setDrawingsStyle".equals\(operation\)\)/);
    assert.match(flat(after), /returnresult;$/);
});

test('Java static: exact nested drawing decoder rejects coercion and invalid integer metadata', () => {
    assert.match(flat(java), /staticfinalclassDrawingTranslationReceipt\{privateDrawingTranslationReceipt\(\)\{\}staticbooleanchanged\(Objectchanged\)throwsJSONException/);
    order(jDecoder, 'changed instanceof Number', 'throw new JSONException',
        '((Number)changed).doubleValue()', 'Double.isFinite(value)', 'value!=Math.rint(value)',
        'value<0', 'value>128', 'throw new JSONException', 'return value>0');
    assert.doesNotMatch(jDecoder, /removed|4194304|parseDouble|toString|getInt|intValue|longValue/);
});

test('Java static: separate existing compaction decoder retains its original range and field', () => {
    const compaction = body(body(java, /static final class CompactionReceipt\b/), /static boolean changed\(/);
    assert.equal(flat(compaction), 'if(!(removedinstanceofNumber))thrownewJSONException("Compactionremovedmustbenumeric");doublevalue=((Number)removed).doubleValue();if(!Double.isFinite(value)||value!=Math.rint(value)||value<0||value>4194304)thrownewJSONException("Compactionremovedintegerrange");returnvalue>0;');
    const receipt = body(jCommand, /if\("compactData"\.equals\(operation\)\)\{/);
    assert.match(flat(receipt), /CompactionReceipt.changed\(\(\(JSONObject\)result\).get\("removed"\)\)/);
    assert.doesNotMatch(receipt, /DrawingTranslationReceipt|"changed"/);
});

test('Java static: existing observer RuntimeException channel stays bounded', () => {
    const notify = body(java, /private void notifyChanges\(/);
    assert.match(flat(notify), /catch\(RuntimeExceptionerror\)/);
    assert.match(flat(notify), /observerErrors.size\(\)<32/);
    assert.match(notify, /onObserverError/);
});
