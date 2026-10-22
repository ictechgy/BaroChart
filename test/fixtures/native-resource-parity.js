// Shared Node VM / standalone QuickJS test of the checked-in SDK resource.
// Bare QuickJS has no Intl: use a deterministic UTC-only fixture there. This
// checks metadata flow, not Java/Apple timezone bridges or native SDK behavior.
(function(){
 let checks=0;const scenarios=[],ok=(value,message)=>{checks++;if(!value)throw Error(message);};
 const modeledUTC=typeof Intl==='undefined';
 if(modeledUTC)globalThis.Intl={DateTimeFormat:class{constructor(_locale,options){if(options.timeZone!=='UTC')throw Error('Fixture supports UTC only');}formatToParts(date){return ['year','month','day','hour','minute','second'].map((type,i)=>({type,value:[String(date.getUTCFullYear()),String(date.getUTCMonth()+1),String(date.getUTCDate()),String(date.getUTCHours()),String(date.getUTCMinutes()),String(date.getUTCSeconds())][i].padStart(i?2:4,'0')}));}}};
 const binding={key:'resource',revision:'1',adjustmentVersion:'dataset-1',priceUnit:'USD',adjustment:'raw'};
 nativeInit(3,{series:[]});const model=nativeModel,store=model.store,columns=store.columns;
 try{
  nativeAPI.setSymbol({id:'TEST',exchange:'VENUE',timezone:'UTC',currency:'USD',volumeUnit:'shares',priceDecimals:2,tickSize:.01,adjustment:'raw',provider:'external',adjustmentVersion:'symbol-2'});
  const text=nativeSaveWorkspace(binding),doc=Aster.readWorkspaceDocument(text);
  ok(doc.chart.symbol.provider==='external'&&doc.chart.symbol.adjustmentVersion==='symbol-2','optional metadata');
  ok(doc.dataset.adjustmentVersion==='dataset-1','independent binding');
  ok(nativePreflightWorkspace(text,binding).status==='validated-only','preflight');
  ok(nativeSaveWorkspace(binding)===text,'canonical save');scenarios.push('optional symbol metadata');
  for(let i=0;i<3;i++)model.drawings.add({id:'d'+i,type:'horizontal',points:[{time:i,price:i+1}]});
  nativeInput.key('Escape');nativeInput.key('PageUp');ok(model.drawings.selected==='d2','PageUp starts at last drawing');
  nativeInput.key('Escape');nativeInput.key('PageDown');ok(model.drawings.selected==='d0','PageDown starts at first drawing');scenarios.push('unselected keyboard cycle');
  const drawings=new Aster.DrawingStore(),panel={id:'price',left:100,right:900,top:100,bottom:500};
  const layout={panels:[panel],drawingAxis:()=>panel,toScreen:p=>({x:p.time,y:p.price})};
  const id=drawings.add({type:'ellipse',points:[{time:200,price:300},{time:600,price:300}],style:{width:50}});drawings.selected=null;
  ok(Aster.drawingHitTest(drawings,layout,430,320)?.id===id,'collapsed stroked ellipse selects');
  ok(Aster.drawingHitTest(drawings,layout,430,326)===null,'outside collapsed stroke rejects');scenarios.push('collapsed ellipse stroke');
 }finally{model.dispose();}
 ok(store.listeners.size===0&&columns.close.buffer.byteLength>0,'resource lifecycle cleanup');scenarios.push('cleanup');
 return JSON.stringify({case:'native-resource-parity',passed:true,checks,scenarios,modeledUTC});
})();
