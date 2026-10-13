// Source wiring only; no Swift/JSC/Android/JNI host execution.
import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8'),swift=read('../native/AsterNative.swift'),java=read('../native/android/java/dev/aster/charts/AsterEngine.java'),consumer=read('./java-host-consumers/example/WorkspaceConsumer.java');
test('Swift deletion forwards only explicit ids through checked command conversion',()=>{assert.match(swift,/public func deleteDrawings\(_ ids: \[String\]\) throws -> \[String: Any\] \{\s*try ingestionCommand\("deleteDrawings",\[ids\]\)\s*\}/);});
test('Java deletion forwards ids and returns the ordinary command receipt',()=>{assert.match(java,/public JSONObject deleteDrawings\(JSONArray ids\) throws JSONException \{return \(JSONObject\)command\("deleteDrawings",ids\);\}/);});
test('native deletion does not add a count decoder or zero-change host branch',()=>{assert.equal((swift.match(/"deleteDrawings"/g)||[]).length,1);assert.equal((java.match(/"deleteDrawings"/g)||[]).length,1);assert.doesNotMatch(java,/DrawingDeleteReceipt/);});
test('Java consumer typechecks the explicit JSONArray overload',()=>{assert.match(consumer,/return engine.deleteDrawings\(new JSONArray\(new String\[\]\{"trend", "level"\}\)\);/);});
