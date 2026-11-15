import createBaroChart,{createBaroChart as createNamed,createChart,createJavaScriptChart,type BaroChartOwner,type ChartModel} from 'barochart';
import {createChart as createExplicitJavaScript} from 'barochart/javascript';

declare const container:HTMLElement;
declare const model:ChartModel;
const owner:Promise<BaroChartOwner>=createBaroChart(container,{session:{count:12},view:{renderer:'canvas'}});
const named:typeof createBaroChart=createNamed;
const legacy:ReturnType<typeof createChart>=createChart(container,model);
const alias:typeof createChart=createJavaScriptChart;
const explicit:typeof createChart=createExplicitJavaScript;
void [owner,named,legacy,alias,explicit];

// @ts-expect-error Rust is the only backend accepted by the default factory.
createBaroChart(container,{backend:'javascript'});
