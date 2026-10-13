import {BarStore,ChartModel,ChartAPI,seededColumns,buildScene,createLayout,RESOURCE_LIMITS,portableSessionCalendar,defineIndicatorModule,type IndicatorPoint,type TrustedIndicatorModule,type Bar,type Axis,type CrosshairValues} from 'barochart/core';

const store=new BarStore();store.setColumns(seededColumns(32,42));
const axis:Axis={id:'quote',panel:'price',side:'left',precision:4,prefix:'$'};
const model=new ChartModel({store,axes:[axis]});model.addSeries({id:'price',panel:'price',type:'candles'});
const api=new ChartAPI(model);const bar:Bar=store.at(0);const hover:CrosshairValues|null=api.crosshairValues(800,600);
buildScene(model,800,600).commands.length.toFixed();createLayout(model,800,600).axis('price','quote')?.y(bar.close);RESOURCE_LIMITS.maxBars.toFixed();
const calendar:string=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]});
api.addIndicator('session','vwap',{calendar,deviation:2});
const names:string[]=api.registerIndicatorModule('aster.volume-direction',1);
api.addIndicator('pressure',names[0],{factor:1,shift:-2});
const point:IndicatorPoint=api.indicatorValueAt('pressure','signed',0,{mode:'plot',asOfIndex:0});
const setup:string=api.saveStudies(),target=new ChartModel({store});
const imported:{indicators:number;series:number}=new ChartAPI(target).loadStudies(setup);
declare const linked:TrustedIndicatorModule;
if(false)defineIndicatorModule(linked);
void [calendar,point.value,point.sourceIndex,point.sourceTime,imported];
target.dispose();model.dispose();
void hover;
// @ts-expect-error Browser renderer values are intentionally outside the core entry.
import {CanvasChart} from 'barochart/core';
