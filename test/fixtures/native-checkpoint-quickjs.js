(function(){
 let checks=0;const scenarios=new Set(),ok=(value,label)=>{if(!value)throw Error(label);checks++;scenarios.add(label);},throws=(fn,label)=>{let caught=false;try{fn();}catch{caught=true;}ok(caught,label);};
 const name='test.native-checkpoint-quickjs@1/value',Budget=Aster.NativeCheckpointBudget,Records=Aster.NativeCheckpointMap,Entries=Aster.NativeCheckpointEntries;
 const budget=new Budget(),a=new Records(name,{}, {budget}),b=new Records(name,{}, {budget});
 const original={values:[NaN,Infinity,-Infinity,-0,'한🚀']};a.set(0,original);const decoded=a.get(0);
 ok(Number.isNaN(decoded.values[0])&&decoded.values[1]===Infinity&&decoded.values[2]===-Infinity&&Object.is(decoded.values[3],-0)&&decoded.values[4]==='한🚀','number and Unicode codec');
 original.values[4]='changed';decoded.values[4]='changed';ok(a.get(0).values[4]==='한🚀','independent record ownership');
 a.validateHistory(1);ok(a.size===1,'history boundary');throws(()=>a.validateHistory(256),'missing terminal record');
 throws(()=>a.set(1,null),'block alignment');throws(()=>a.set(0,{get value(){throw Error('getter ran');}}),'accessor rejection');
 const bytes=a.encodedBytes;throws(()=>a.set(0,'x'.repeat(131072)),'record limit');ok(a.encodedBytes===bytes&&budget.usedBytes===bytes,'failed record atomicity');
 const exact=new Records(name,{}, {budget:new Budget(262144)});exact.set(0,'x'.repeat(131070));ok(exact.encodedBytes===262144,'exact record limit');throws(()=>exact.set(256,null),'aggregate limit');exact.dispose();
 nativeCheckpointQuickjsProbe.onValidate=()=>a.clear();throws(()=>a.set(256,null),'set reentry');nativeCheckpointQuickjsProbe.onValidate=null;ok(a.size===0&&budget.usedBytes===0,'clear prevents resurrection');
 a.set(0,null);nativeCheckpointQuickjsProbe.onValidate=()=>a.clear();throws(()=>a.validateHistory(1),'history reentry');nativeCheckpointQuickjsProbe.onValidate=null;
 a.set(0,null);b.set(0,null);const before=budget.usedBytes;
 throws(()=>new Entries([['x',{checkpoints:a}],['x',{checkpoints:b}],['y',{checkpoints:b}]]),'constructor atomic ownership');ok(a.get(0)===null&&b.get(0)===null&&budget.usedBytes===before,'constructor preserves inputs');
 const owners=new Entries([['a',{checkpoints:a}]]);throws(()=>new Entries([['a',{checkpoints:a}]]),'cross registry ownership');
 const held=new Float64Array([1,-0,NaN]);owners.set('a',{checkpoints:b,arrays:[held]});throws(()=>a.get(0),'retired get');owners.clear();ok(budget.usedBytes===0,'retired ledger release');ok(held[0]===1&&Object.is(held[1],-0)&&Number.isNaN(held[2]),'held outputs survive');throws(()=>b.set(0,null),'terminal disposed set');
 const store=new Aster.BarStore(),engine=new Aster.IndicatorEngine(store),ledger=new Budget();engine.entries=new Entries();
 for(const id of ['ema','rsi','bollinger']){engine.add(id,id,{});const entry=engine.entries.get(id);entry.checkpoints=new Records(id,{}, {budget:ledger});engine.entries.set(id,entry);}
 store.setColumns(Aster.seededColumns(513,7));
 const parity=label=>{const oracle=new Aster.IndicatorEngine(store);try{for(const id of ['ema','rsi','bollinger']){const actual=engine.get(id),expected=oracle.add(id,id,{});for(const key of Object.keys(actual.outputs)){const x=actual.outputs[key],y=expected.outputs[key];ok(x.length===y.length&&x.every((v,i)=>Object.is(v,y[i])),label+' '+id+'/'+key);}engine.entries.get(id).checkpoints.validateHistory(store.length);}}finally{oracle.dispose();}};
 parity('initial');let last=store.at(store.length-1);store.update(store.length-1,{...last,close:last.close+.1,high:Math.max(last.high,last.close+.1)});parity('update');last=store.at(store.length-1);store.append({...last,time:last.time+60000});parity('append');const old=store.at(5);store.update(5,{...old,close:old.close-.1,low:Math.min(old.low,old.close-.1)});parity('correction');store.setColumns(Aster.seededColumns(17,9));parity('reset');engine.dispose();ok(ledger.usedBytes===0&&store.listeners.size===0,'engine cleanup');
 return JSON.stringify({case:'native-checkpoint-quickjs',passed:true,checks,scenarios:[...scenarios],scope:'standalone Linux QuickJS checkpoint storage; no JNI/JSC'});
})()
