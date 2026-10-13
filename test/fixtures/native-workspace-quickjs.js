// Standalone QuickJS assertions; no browser/JNI/Intl/timezone emulation.
(function(){
 let checks=0;const scenarios=new Set();const ok=(v,label)=>{if(!v)throw Error(label);checks++;scenarios.add(label);},throws=(fn,label)=>{let caught=false;try{fn();}catch{caught=true;}ok(caught,label);};
 const binding={key:'fixture:ASTER/1m',revision:'r1',adjustmentVersion:'raw-v1',priceUnit:'USD',adjustment:'raw'};
 nativeInit(33,{series:[]});let notifications=0;nativeAPI.invalidate=()=>{notifications++;};
 nativeAPI.addIndicator('ema','ema',{period:5});nativeAPI.addIndicator('hidden','test.native-workspace@1/pair',{shift:3,zero:-0});
 nativeAPI.addSeries({id:'line',type:'line',panel:'price',indicator:'ema'});
 nativeAPI.addDrawing({id:'a',type:'trendline',panel:'price',points:[{time:1700000000000.125,price:-0},{time:1700000000001.75,price:2.25}],axisId:null,seriesId:null});
 const model=nativeModel,api=nativeAPI,input=nativeInput,store=model.store,columns=store.columns,version=store.version,listeners=store.listeners.size,entry=model.indicators.entries.get('ema'),values=entry.arrays[0],history=model.drawings.undoStack,notice=notifications;
 const text=nativeSaveWorkspace(binding),receipt=nativePreflightWorkspace(text,binding),doc=Aster.readWorkspaceDocument(text);
 ok(receipt.status==='validated-only'&&receipt.restored===false,'receipt is validation only');
 ok(text===Aster.saveWorkspace(api,binding),'canonical save');
 ok(receipt.counts.outputs===3&&receipt.counts.indicators===2,'hidden outputs counted');
 ok(receipt.projectedOutputBytes===64*3*8&&receipt.outputByteLimit===268435456,'capacity budget');
 ok(receipt.modules.length===1&&receipt.modules[0].stateVersion===3,'linked module binding');
 ok(Object.is(doc.indicators[1].params.zero,-0),'negative zero parameter');
 ok(Object.is(doc.drawings.drawings[0].points[0].price,0),'public drawing copy normalizes negative zero');
 const signed=Aster.safeCheckpointParse(text);signed.drawings.drawings[0].points[0].price=-0;ok(Object.is(Aster.readWorkspaceDocument(Aster.safeCheckpointStringify(signed)).drawings.drawings[0].points[0].price,-0),'document codec preserves negative zero anchor');
 ok(doc.drawings.drawings[0].points[0].time===1700000000000.125,'fractional anchor');
 ok(doc.drawings.drawings[0].axisId==null,'default drawing binding');
 signed.drawings.drawings[0].axisId=null;ok(Aster.readWorkspaceDocument(Aster.safeCheckpointStringify(signed)).drawings.drawings[0].axisId===null,'document null binding');
 ok(nativeModel===model&&nativeAPI===api&&nativeInput===input&&store.columns===columns,'owner identities');
 ok(store.version===version&&store.listeners.size===listeners&&entry.arrays[0]===values,'source and output identity');
 ok(model.drawings.undoStack===history&&notifications===notice,'history and notifications');
 const before=[nativeWorkspaceProbe.creates,nativeWorkspaceProbe.steps,nativeWorkspaceProbe.snapshots,nativeWorkspaceProbe.checkpointChecks];
 nativeWorkspaceProbe.failCreate=true;nativePreflightWorkspace(text,binding);nativeWorkspaceProbe.failCreate=false;
 ok(JSON.stringify(before)===JSON.stringify([nativeWorkspaceProbe.creates,nativeWorkspaceProbe.steps,nativeWorkspaceProbe.snapshots,nativeWorkspaceProbe.checkpointChecks]),'no create/step/checkpoint');
 throws(()=>nativePreflightWorkspace(text,{...binding,revision:'r2'}),'binding mismatch');
 throws(()=>nativePreflightWorkspace('{bad',binding),'malformed document');
 throws(()=>nativePreflightWorkspace(text.replace('"version":1','"version":2'),binding),'unknown schema version');
 const invalid=Aster.safeCheckpointParse(text);invalid.indicators[0].outputs=['wrong'];throws(()=>nativePreflightWorkspace(Aster.safeCheckpointStringify(invalid),binding),'output mismatch');
 const badModule=Aster.safeCheckpointParse(text);badModule.indicators[1].module.version=99;throws(()=>nativePreflightWorkspace(Aster.safeCheckpointStringify(badModule),binding),'module version');
 model.drawings.begin();throws(()=>nativeSaveWorkspace(binding),'active drawing transaction save');ok(nativePreflightWorkspace(text,binding).status==='validated-only','preflight retains gesture');model.drawings.cancel();
 const row=store.at(store.length-1);store.update(store.length-1,{...row,close:row.close+.01,high:Math.max(row.high,row.close+.01)});const dirty=entry.dirty;
 nativePreflightWorkspace(text,binding);ok(entry.dirty===dirty&&entry.arrays[0]===values,'dirty entry not calculated');
 nativeWorkspaceProbe.onFactory=()=>{const row=store.at(store.length-1);store.update(store.length-1,{...row,volume:row.volume+1});};throws(()=>nativePreflightWorkspace(text,binding),'factory source mutation stale');nativeWorkspaceProbe.onFactory=null;
 nativeWorkspaceProbe.onFactory=()=>{globalThis.nativeInput=new Aster.InteractionController(model,()=>nativeSize);};throws(()=>nativePreflightWorkspace(text,binding),'factory input replacement stale');nativeWorkspaceProbe.onFactory=null;globalThis.nativeInput=input;
 nativeWorkspaceProbe.params.length=0;
 for(let i=0;i<100;i++){nativePreflightWorkspace(text,binding);throws(()=>nativePreflightWorkspace(text,{...binding,key:'wrong'}),'repeat invalid binding');nativeWorkspaceProbe.params.length=0;}
 ok(store.listeners.size===listeners,'repeated reads preserve listener count');ok(nativeSaveWorkspace(binding)===text,'recovery canonical save');
 model.dispose();ok(store.listeners.size===0,'model cleanup');throws(()=>nativePreflightWorkspace(text,binding),'disposed preflight');throws(()=>nativeSaveWorkspace(binding),'disposed save');
 return JSON.stringify({case:'workspace-quickjs',passed:true,checks,iterations:100,scenarios:[...scenarios],scope:'standalone Linux QuickJS; no JNI/Java/Swift/JSC/device/Intl'});
})()
