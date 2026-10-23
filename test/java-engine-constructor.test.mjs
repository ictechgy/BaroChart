import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractConstructor, renderHarness, PRODUCTION_SOURCE} from '../scripts/check-java-engine-constructor.mjs';

test('constructor harness is derived from the production constructor and keeps Java execution explicit', async () => {
    const source = await readFile(new URL('../native/android/java/dev/aster/charts/AsterEngine.java', import.meta.url), 'utf8');
    const body = extractConstructor(source);
    const fixture = renderHarness(body);
    assert.equal(PRODUCTION_SOURCE, 'native/android/java/dev/aster/charts/AsterEngine.java');
    assert.match(body, /try\(InputStream in=context\.getAssets\(\)\.open\("aster-core\.js"\)\)/);
    assert.match(body, /handle=create\(sourceBundle\)/);
    assert.match(body, /catch\(JSONException\|RuntimeException\|Error error\)/);
    assert.match(fixture, /asset close failure must happen before native create/);
    assert.match(fixture, /System\.out\.println\("constructor source checks=7 created=" \+ created/);
    assert.doesNotMatch(fixture, /System\.loadLibrary/);
});
