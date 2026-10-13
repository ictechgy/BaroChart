// Conservative portable layout bounds, not a native glyph measurement API.
// Fonts stay renderer-owned; explicit ellipsis preserves complete label metadata.
export function labelMetrics(font) {
 const size=Number(String(font).match(/([0-9.]+)px/)?.[1]??12);
 return {size,ascent:size*1.12,descent:size*.38,height:size*1.5};
}
export function labelWidth(value,metrics) {
 let units=0;for(const c of value){const code=c.codePointAt(0);units+=code>127?1.2:'MW@%'.includes(c)?.98:.74;}return units*metrics.size;
}
export function fitLabel(value,maxWidth,metrics) {
 const fullText=String(value),singleLine=fullText.replace(/\s/g,' ');if(!(maxWidth>0))return null;
 const fullWidth=labelWidth(singleLine,metrics);if(fullWidth<=maxWidth)return {text:singleLine,fullText,width:fullWidth};
 const ellipsis='…',endWidth=labelWidth(ellipsis,metrics);if(endWidth>maxWidth)return null;
 let text='',width=0;for(const c of singleLine){const next=labelWidth(c,metrics);if(width+next+endWidth>maxWidth)break;text+=c;width+=next;}return {text:text+ellipsis,fullText,width:width+endWidth};
}
export function labelCommand(value,x,y,maxWidth,font,color,clip,metadata={}) {
 const metrics=labelMetrics(font),fit=fitLabel(value,maxWidth,metrics);if(!fit)return null;
 return {op:'text',x,y,text:fit.text,fullText:fit.fullText,font,color,clip,labelBounds:[x,y-metrics.ascent,fit.width,metrics.height],...metadata};
}
export function panelTitle(model,panel) {
 const labels=model.series.filter(s=>s.panel===panel.id&&s.visible!==false).map(s=>s.label??s.indicator).filter(Boolean);
 return [panel.label??panel.id,...new Set(labels)].join(' · ');
}
