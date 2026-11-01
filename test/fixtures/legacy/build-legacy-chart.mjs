// 이름 변경(Aster → BaroChart) 이전 저장본 호환 검사용 결정적 차트.
// 이 파일로 만든 문서를 2026-11-01 main(1460646 + 기준선 PR) 코드로 저장해 픽스처로 고정했다.
import {BarStore,ChartModel,ChartAPI,InteractionController} from '../../../src/core/index.mjs';

/** 작업공간 저장에 쓰는 데이터셋 바인딩 */
export const LEGACY_BINDING={key:'legacy-rename',revision:'1',adjustmentVersion:'raw',priceUnit:'USD',adjustment:'raw'};

/**
 * 지표·시리즈·드로잉을 갖춘 차트를 만든다.
 * @returns {{model: ChartModel, api: ChartAPI}} 호출자가 model.dispose()로 정리한다
 */
export function buildLegacyChart(){
 const T=1700000000000,rows=Array.from({length:40},(_,i)=>({time:T+i*60000,open:100+i,high:103+i,low:99+i,close:102+i,volume:500+i}));
 const model=new ChartModel({store:new BarStore(rows)}),controller=new InteractionController(model,()=>({width:800,height:500})),api=new ChartAPI(model,{controller});
 model.addSeries({id:'price',type:'candles',panel:'price'});
 api.addIndicator('ema5','ema',{period:5});
 api.addSeries({id:'ema5-line',type:'line',panel:'price',indicator:'ema5',color:'#f0b755'});
 api.addDrawing({id:'level',type:'horizontal',points:[{time:T+10*60000,price:110}],text:'Legacy 수평선'});
 api.addDrawing({id:'trend',type:'trendline',points:[{time:T,price:100},{time:T+20*60000,price:125}]});
 api.setVisibleRange(5,35);
 return {model,api};
}
