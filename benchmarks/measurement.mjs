// Half-open operation/task intervals: include a task which began before the
// operation if it was still running after the operation began.
export function overlappingTasks(tasks,begin,end){
 if(!Number.isFinite(begin)||!Number.isFinite(end)||end<begin)throw new RangeError('Measurement interval');
 return tasks.flatMap(task=>{if(!Number.isFinite(task.startTime)||!Number.isFinite(task.duration)||task.duration<0)throw new TypeError('Measurement task interval');const overlapMs=Math.min(end,task.startTime+task.duration)-Math.max(begin,task.startTime);return overlapMs>0?[{...task,overlapMs}]:[];});
}
export function percentile(values,fraction=.95){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))]:0;}
