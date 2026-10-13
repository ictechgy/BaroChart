import {resolve,join} from 'node:path';import {tmpdir} from 'node:os';
export function option(name,fallback){const key='--'+name,a=process.argv.find(x=>x.startsWith(key+'='));if(a)return a.slice(key.length+1);const index=process.argv.indexOf(key);return index>=0?process.argv[index+1]:fallback;}
export const scriptRoot=import.meta.dirname;
export const outputRoot=resolve(option('output-root',process.env.ASTER_PROFILE_OUTPUT_ROOT??join(tmpdir(),'aster-cycle10-profile')));
export const candidateRoot=resolve(option('candidate-root',process.env.ASTER_CANDIDATE_ROOT??process.cwd()));
const rawBaseline=option('baseline-root',process.env.ASTER_BASELINE_ROOT);export const baselineRoot=rawBaseline?resolve(rawBaseline):undefined;
export const hashOption=option('candidate-core-sha',process.env.ASTER_CANDIDATE_CORE_SHA);
