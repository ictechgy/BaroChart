// Demo-local asynchronous file ownership. File.text() itself is not abortable.
// Stale completions are ignored before calling the existing drawing API.
export function createDrawingFileImport({getChart,onStatus,onError}){
 let generation=0;
 const active=owner=>owner.drawings.transaction||owner.controller?.gesture||owner.controller?.pointers?.size;
 function capture(){
  const chart=getChart(),api=chart?.api,model=chart?.model,drawings=model?.drawings,controller=chart?.controller;
  if(!chart||chart.disposed||!api||api.model!==model||!drawings||model.disposed)throw new Error('Chart is not ready for drawing import');
  if(controller&&controller.model!==model)throw new Error('Drawing import controller owner mismatch');
  const owner={chart,api,model,drawings,controller,items:drawings.items,selected:drawings.selected,symbol:model.symbol,store:model.store};
  if(active(owner))throw new Error('Finish or cancel the active gesture before drawing import');
  return owner;
 }
 function current(owner){
  return getChart()===owner.chart&&!owner.chart.disposed&&!owner.model.disposed&&owner.chart.api===owner.api&&owner.chart.model===owner.model&&owner.api.model===owner.model&&owner.model.drawings===owner.drawings&&owner.chart.controller===owner.controller&&(!owner.controller||owner.controller.model===owner.model)&&owner.model.store===owner.store&&owner.model.symbol===owner.symbol&&owner.drawings.items===owner.items&&owner.drawings.selected===owner.selected&&!active(owner);
 }
 function stale(){onStatus('파일을 읽는 동안 차트나 도형 상태가 바뀌어 불러오기를 취소했습니다. 현재 상태를 확인한 뒤 파일을 다시 선택하세요.');return {status:'stale'};}
 return {
  cancel(){generation++;},
  async read(file){
   const token=++generation;if(!file)return {status:'empty'};
   let owner,applying=false;
   try{
    if(!Number.isFinite(file.size)||file.size<0||file.size>16*1024*1024)throw new RangeError('File size limit');
    owner=capture();
    const text=await file.text();
    if(token!==generation)return {status:'superseded'};
    if(!current(owner))return stale();
    applying=true;owner.api.loadDrawings(text);
    // A host callback can start a newer intent during invalidation. Do not
    // overwrite its status even though this older import has already committed.
    if(token===generation)onStatus('도형을 불러왔습니다.');
    return {status:'loaded'};
   }catch(error){
    if(token!==generation)return {status:'superseded'};
    const changed=!!(applying&&owner&&owner.drawings.items!==owner.items);
    if(!applying&&owner&&!current(owner))return stale();
    onError(error,{changed});return {status:changed?'applied-error':'error'};
   }
  },
 };
}
