import {attachComparison} from './comparison-view.mjs';
const view=attachComparison(document.getElementById('comparison'));
window.addEventListener('pagehide',event=>{if(!event.persisted)view.destroy();});
window.addEventListener('pageshow',event=>{if(event.persisted){view.chart.resize();try{view.refresh();}catch{}}});
