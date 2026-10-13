// Pure calculation example. Inject real session schedules externally.
import {resampleOHLCV,alignConfirmedByTime} from '../src/core/index.mjs';

export function confirmedFiveMinuteClose(columns,length,calendar,asOf) {
 const higher=resampleOHLCV({columns,length},{sourceIntervalMs:60000,targetIntervalMs:300000,calendar,kinds:['regular'],asOf,partialTarget:'include-unconfirmed'});
 // Decisions occur at each one-minute close, not at its open label.
 const decisions=new Float64Array(length);
 for(let i=0;i<length;i++)decisions[i]=columns.time[i]+60000;
 const closeAtDecision=alignConfirmedByTime(decisions,higher.columns.close,higher);
 return {higher,closeAtDecision};
}
