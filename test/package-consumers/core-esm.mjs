import {BarStore,ChartModel,seededColumns,buildScene} from 'barochart/core';
export function smoke(){const store=new BarStore();store.setColumns(seededColumns(32,42));const model=new ChartModel({store});model.addSeries({id:'price',type:'candles',panel:'price'});const result={bars:store.length,commands:buildScene(model,800,600).commands.length};model.dispose();return result;}
