import {resampleFromSessions} from '../core/resample.mjs';
import {FIELDS} from '../core/data.mjs';
export function computeResampleRequest(request){
 if(!request||request.schema!=='aster.resample-request'||request.version!==1||request.kind!=='resample'||!Number.isSafeInteger(request.jobId)||request.jobId<1)throw new TypeError('Resampling request protocol');
 const {binding,options}=request;if(!binding||['sourceIntervalMs','targetIntervalMs','asOf','partialTarget'].some(k=>binding[k]!==options[k]))throw new TypeError('Resampling request binding');
 const result=resampleFromSessions({columns:request.columns,length:binding.length},options,request.sessions);
 return {schema:'aster.resample-result',version:1,jobId:request.jobId,kind:'resample',binding:{...binding},result};
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=({data})=>{try{const packet=computeResampleRequest(data),result=packet.result;self.postMessage(packet,[...FIELDS.map(field=>result.columns[field].buffer),...['endTime','availableAt','sourceFrom','sourceTo','complete','confirmed'].map(key=>result[key].buffer)]);}catch(error){self.postMessage({schema:'aster.resample-error',version:1,jobId:data?.jobId,kind:'resample',message:String(error.message).slice(0,256)});}};
