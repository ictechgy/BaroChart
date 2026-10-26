import {ChartModel,createChart} from 'barochart';

const model=new ChartModel();
const chart=createChart(document.createElement('div'),model);
const chartDisposed:boolean=chart.disposed;
const modelDisposed:boolean|undefined=model.disposed;
window.addEventListener('pagehide',event=>{
 if(!event.persisted)chart.destroy({disposeModel:true});
});
window.addEventListener('pageshow',event=>{
 if(event.persisted&&!chart.disposed)chart.resize();
});
// @ts-expect-error lifecycle state is observable, not a consumer setting
chart.disposed=false;
// @ts-expect-error model disposal state is not a consumer setting
model.disposed=false;
void [chartDisposed,modelDisposed];
