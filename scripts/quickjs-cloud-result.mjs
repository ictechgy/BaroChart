// Keep required coverage independent of the executed fixture's own claims.
export const QUICKJS_WORKSPACE_SCENARIOS=Object.freeze([
 'receipt is validation only','canonical save','hidden outputs counted','capacity budget','linked module binding','negative zero parameter','public drawing copy normalizes negative zero','document codec preserves negative zero anchor','fractional anchor','default drawing binding','document null binding','owner identities','source and output identity','history and notifications','no create/step/checkpoint','binding mismatch','malformed document','unknown schema version','output mismatch','module version','active drawing transaction save','preflight retains gesture','dirty entry not calculated','factory source mutation stale','factory input replacement stale','repeat invalid binding','repeated reads preserve listener count','recovery canonical save','model cleanup','disposed preflight','disposed save'
]);
export function validateQuickjsCloudResults(results){
 const names=['workspace-quickjs','workspace-runtime-cleanup','oom-cleanup','interrupt-cleanup'];
 if(!Array.isArray(results)||results.length!==names.length||results.some((r,i)=>!r||r.case!==names[i]||r.passed!==true))throw new TypeError('QuickJS case coverage');
 const fixture=results[0];if(fixture.checks!==130||fixture.iterations!==100||!Array.isArray(fixture.scenarios)||fixture.scenarios.length!==QUICKJS_WORKSPACE_SCENARIOS.length||new Set(fixture.scenarios).size!==fixture.scenarios.length||QUICKJS_WORKSPACE_SCENARIOS.some(s=>!fixture.scenarios.includes(s)))throw new TypeError('QuickJS workspace coverage');
 for(let i=1;i<results.length;i++){const r=results[i];if(r.finalLiveBytes!==0||r.finalAllocationCount!==0||!Number.isSafeInteger(r.peakRequestedBytes)||r.peakRequestedBytes<=0||r.peakRequestedBytes>(i===1?128:8)*1024*1024)throw new TypeError('QuickJS cleanup accounting');}
 return results;
}

export const QUICKJS_CHECKPOINT_SCENARIOS=Object.freeze([
 'number and Unicode codec','independent record ownership','history boundary','missing terminal record','block alignment','accessor rejection','record limit','failed record atomicity','exact record limit','aggregate limit','set reentry','clear prevents resurrection','history reentry','constructor atomic ownership','constructor preserves inputs','cross registry ownership','retired get','retired ledger release','held outputs survive','terminal disposed set',
 ...['initial','update','append','correction','reset'].flatMap(phase=>['ema/value','rsi/value','bollinger/middle','bollinger/upper','bollinger/lower'].map(output=>phase+' '+output)),'engine cleanup'
]);
export function validateQuickjsCheckpointResults(results){
 const first=results?.[0];if(first?.case!=='native-checkpoint-quickjs'||first.passed!==true||first.checks!==46||!Array.isArray(first.scenarios)||first.scenarios.length!==QUICKJS_CHECKPOINT_SCENARIOS.length||new Set(first.scenarios).size!==first.scenarios.length||QUICKJS_CHECKPOINT_SCENARIOS.some(s=>!first.scenarios.includes(s)))throw new TypeError('QuickJS checkpoint coverage');
 // Same independent cleanup checks; do not trust a fixture's counters alone.
 validateQuickjsCloudResults([{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...results.slice(1)]);return results;
}

export const QUICKJS_NATIVE_TARGET_SCENARIOS=Object.freeze([
 'isolated target admission','bounded logical admission','copied source buffers','bounded target progress','canonical restored configuration','saved chart configuration','fractional offscreen view','fractional bound drawing anchors','transient UI reset','restored source metadata','owned source columns','source remains unchanged','finish drops wrapper references','single finish ownership','wrapper dispose preserves returned model',
 ...['initial'].flatMap(phase=>['ema/value','rsi/value','bollinger/middle','bollinger/upper','bollinger/lower','bounded checkpoints'].map(output=>phase+' '+output)),
 'source changes stay independent',...['update','append','correction'].flatMap(phase=>['ema/value','rsi/value','bollinger/middle','bollinger/upper','bollinger/lower','bounded checkpoints'].map(output=>phase+' '+output)),
 'target changes stay independent','indicator retirement preserves held outputs','retired checkpoint access rejected','returned model cleanup','malformed target metadata','target binding mismatch','target output schema mismatch','combined admission limit','partial transfer rejected','partial transfer cleanup','malformed copied column rejected','malformed copied column cleanup','partial calculation owns checkpoints','partial calculation cleanup','cancelled checkpoint access rejected','ready mutation rejected','ready mutation cleanup','empty target configuration','empty bounded checkpoints','empty target ownership','empty target cleanup','failed targets preserve source','all source and target listeners released'
]);
export function validateQuickjsNativeTargetResults(results){const first=results?.[0];if(first?.case!=='native-workspace-target-quickjs'||first.passed!==true||first.checks!==63||!Array.isArray(first.scenarios)||first.scenarios.length!==QUICKJS_NATIVE_TARGET_SCENARIOS.length||new Set(first.scenarios).size!==first.scenarios.length||QUICKJS_NATIVE_TARGET_SCENARIOS.some(s=>!first.scenarios.includes(s)))throw new TypeError('QuickJS native target coverage');validateQuickjsCloudResults([{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...results.slice(1)]);return results;}

export const QUICKJS_NATIVE_SOURCE_SCENARIOS=Object.freeze([
 'source ingestion lease acquired','raw checkpoint admission is lazy','bounded source admission progress',
 'exact raw checkpoint footprint','source backing allocations charged once','admission avoids source recalculation',
 'source cache identities and values preserved','empty ingestion ring logical reservation','captured metadata and retained admission',
 'completed admission does not double charge','source slices borrow live buffers','target transfer owns separate buffers',
 'bounded source-to-target preparation','source finished receipt','source finish releases lease and references',
 'finished source capture rejects reuse','source listeners and undetached columns survive','source-to-target canonical save',
 'fractional view and drawing anchors','target transient UI reset','owned target columns match source',
 'empty ingestion policy cursor and pause preserved','restored ema/value','restored rsi/value',
 'restored bounded native checkpoint ownership','encoded source accounting avoids decode','encoded capture cleanup preserves owner',
 'target wrapper preserves returned ownership','source mutation stays independent','corrected ema/value','corrected rsi/value',
 'target correction stays independent','empty source admission','empty source-to-target canonical save','empty ema/value','empty rsi/value',
 'empty source ingestion state preserved','empty source cleanup and target ownership','combined budget exact boundary',
 'combined budget rejects one byte short','budget failure precedes target allocation','copy before admission rejected',
 'early copy failure releases source','lease reused after early copy failure','incomplete transfer cannot finish',
 'incomplete transfer releases source','partial cancellation releases source','lease reused after cancellation',
 'uncopyable raw checkpoint rejected','uncopyable record avoids getters and releases lease','lease reused after raw checkpoint failure',
 'raw checkpoint record byte limit','oversized raw record releases lease','stale data rejected','stale data releases source',
 'lease reused after stale data','stale UI rejected','stale UI releases source','lease reused after stale UI',
 'stale revision rejected','stale revision releases source','lease reused after stale revision',
 'final source freshness checked after target ready','stale ready target discarded independently',
 'lease reused after final freshness failure','incremental admission detects UI change','admission stale releases source',
 'host registration binds source capture','duplicate registration cannot overwrite source','wrong registration preserves source',
 'lost begin response can abort by registration','lost abort response retries idempotently',
 'retired registration cannot be reused','old registration cannot abort new job',
 'all captures models leases and listeners released'
]);
export function validateQuickjsNativeSourceResults(results){const first=results?.[0];if(first?.case!=='native-workspace-source-quickjs'||first.passed!==true||first.checks!==75||!Array.isArray(first.scenarios)||first.scenarios.length!==QUICKJS_NATIVE_SOURCE_SCENARIOS.length||new Set(first.scenarios).size!==first.scenarios.length||QUICKJS_NATIVE_SOURCE_SCENARIOS.some(s=>!first.scenarios.includes(s)))throw new TypeError('QuickJS native source coverage');validateQuickjsCloudResults([{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...results.slice(1)]);return results;}

export const QUICKJS_DATA_EXPLORER_SCENARIOS=Object.freeze([
 'index selection defaults to last stored row','exact stored timestamp selection','exact missing session timestamp returns null',
 'at-or-before crosses missing session gap','selection before history returns null','selection after history finds last row',
 'index beyond history returns null','selection after explicit cutoff returns null','primary OHLCV preserves stored time and symbol',
 'hidden rows omitted by default','hidden rows explicitly included','series labels axes panels and symbols remain distinct',
 'row causality distinguishes host alignment from canonical provenance',
 'positive plot offset uses earlier source','negative plot offset permits current hindsight','negative plot offset respects historical cutoff',
 'plot offset outside source remains missing','SMA current values match independent arithmetic','canonical SMA historical values match independent arithmetic',
 'SMA warmup retains source position','external NaN gap retains source position','raw Float64 values avoid display rounding',
 'raw signed zero survives native command','queries preserve source buffers versions and listeners','queries preserve model viewport hover and input',
 'queries preserve drawing transaction and history','queries preserve pending ingestion and pause state','queries never invoke core invalidate callback',
 'returned snapshots own their records and arrays','external infinity is reported as an explicit gap','historical cutoff uses currently corrected source',
 'query accessor rejected without invocation','option accessor rejected without invocation','optional prototype getters are never invoked',
 'inherited selection record rejected','invalid selections reject as a bounded group','invalid options reject as a bounded group',
 'native command rejects excess arguments','accessor API owner rejected without invocation','invalid reads preserve getter and notification counters',
 'custom historical cutoff is unsupported','custom historical query skips lazy calculation','custom latest cutoff remains available',
 'custom latest cutoff executes one lazy calculation','linked causal declaration is not historical certification','linked historical query skips lazy calculation',
 'linked latest cutoff remains available','registry name cannot forge canonical definition origin','forged historical query skips lazy calculation',
 'altered canonical create loses historical certification','altered canonical outputs lose historical certification','altered canonical offsets lose historical certification',
 'replaced canonical registry loses historical certification','source callback reentry rejects a mixed snapshot','query recovers after source callback reentry',
 'disposing one model preserves shared source owner','shared source owner observes supported updates','disposed ingestion releases pending ownership',
 'disposed data query rejected','exact 256 series result limit','series limit rejects overflow without truncation',
 'empty source returns null','all models release listeners and preserve source buffers'
]);
export function validateQuickjsDataExplorerResults(results){
 const first=results?.[0];
 if(!Array.isArray(results)||first?.case!=='data-explorer-quickjs'||first.passed!==true||first.checks!==63||!Array.isArray(first.scenarios)||first.scenarios.length!==QUICKJS_DATA_EXPLORER_SCENARIOS.length||new Set(first.scenarios).size!==first.scenarios.length||QUICKJS_DATA_EXPLORER_SCENARIOS.some(s=>!first.scenarios.includes(s)))throw new TypeError('QuickJS data explorer coverage');
 // Fixture assertions do not substitute for the C host's normal/OOM/interrupt accounting.
 validateQuickjsCloudResults([{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...results.slice(1)]);return results;
}

export const QUICKJS_INDICATOR_REENTRY_SCENARIOS=Object.freeze([
 'native model exposes bundled indicator engine','direct get rejects source mutation and recovers',
 'callback reset invalidates and recovers','callback empty invalidates and recovers',
 'middle yield source mutation rejects before writes','final yield source mutation rejects before writes',
 'same entry recursion rejects and releases owner','independent entry calculation remains allowed',
 'superseded next preserves new generation','superseded return preserves new generation','superseded throw preserves new generation',
 'suspended remove cannot write retired buffers','suspended replacement cannot write retired buffers','suspended dispose cannot revive entries',
 'failed add preserves callback replacement','partial EMA supersede matches fresh oracle','partial EMA return matches fresh oracle','partial EMA throw matches fresh oracle',
 'native checkpoint validator mutation rejects and recovers','native checkpoint validator reset rejects and recovers','native checkpoint validator disposal rejects clean publication',
 'realm depth 31 succeeds across one and multiple engines','realm depth 32 succeeds across one and multiple engines','realm depth 33 rejects across one and multiple engines',
 'fresh remove add recursion stops at 32 and recovers',
 'all models engines checkpoints and listeners released'
]);
export function validateQuickjsIndicatorReentryResults(results){
 const first=results?.[0];
 if(!Array.isArray(results)||first?.case!=='indicator-reentry-quickjs'||first.passed!==true||first.checks!==26||!Array.isArray(first.scenarios)||first.scenarios.length!==QUICKJS_INDICATOR_REENTRY_SCENARIOS.length||new Set(first.scenarios).size!==first.scenarios.length||QUICKJS_INDICATOR_REENTRY_SCENARIOS.some(s=>!first.scenarios.includes(s)))throw new TypeError('QuickJS indicator reentry coverage');
 // Retain the independent host normal/OOM/interrupt cleanup gate in this mode.
 validateQuickjsCloudResults([{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...results.slice(1)]);return results;
}

export const QUICKJS_NATIVE_CONTROLS_SCENARIOS=Object.freeze([
 'off and explicit action validation','navigation and refresh compute zero','explicit read and refreshed text',
 'unchanged receipt preserves owner and version','changed volume replaces and notifies once',
 'whole batch validates before unchanged admission','signed zero remains distinct','append anchor and legacy publication',
 'gesture rejection preserves off state','cleanup preserves borrowed buffers'
]);
export function validateQuickjsNativeControlsResults(results){
 const r=results?.[0];if(r?.case!=='native-controls-quickjs'||r.passed!==true||r.checks!==23||!Array.isArray(r.scenarios)||r.scenarios.length!==QUICKJS_NATIVE_CONTROLS_SCENARIOS.length||new Set(r.scenarios).size!==r.scenarios.length||QUICKJS_NATIVE_CONTROLS_SCENARIOS.some(s=>!r.scenarios.includes(s)))throw new TypeError('QuickJS native controls coverage');
 validateQuickjsCloudResults([{case:'workspace-quickjs',passed:true,checks:130,iterations:100,scenarios:[...QUICKJS_WORKSPACE_SCENARIOS]},...results.slice(1)]);return results;
}
