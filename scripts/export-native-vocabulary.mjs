// 코어 JS의 어휘(지표 35종·드로잉 16종·시리즈 5종·테마)를 네이티브 타입 API 일치 테스트용 JSON으로 내보낸다.
// Swift(Tests/BaroChartTests/Resources)와 Android(androidTest assets)가 같은 파일을 읽어
// enum 원시값이 코어와 어긋나면 테스트가 실패하게 한다. 코어가 바뀌면 이 스크립트를 다시 실행한다.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {builtinIndicators} from '../src/core/indicators.mjs';
import {DRAWING_TYPES} from '../src/core/drawings.mjs';
import {DARK_THEME,LIGHT_THEME} from '../src/core/model.mjs';
import {THEME_KEYS} from '../src/core/contracts.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
/** 일치 테스트가 읽는 출력 경로(저장소 루트 기준) */
export const VOCABULARY_OUTPUTS=['Tests/BaroChartTests/Resources/vocabulary.json','native/android/library/src/androidTest/assets/vocabulary.json'];

/** model.mjs의 시리즈 타입 검증 목록을 읽는다(코어에 상수 export가 없어 소스에서 추출) */
async function seriesTypes(){
 const source=await readFile(root+'src/core/model.mjs','utf8');
 const match=/if \(!\[([^\]]+)\]\.includes\(options\.type\)\) throw new Error\('Unknown series type'\)/.exec(source);
 if(!match)throw new Error('Series type list not found in src/core/model.mjs; update export-native-vocabulary.mjs');
 return match[1].split(',').map(item=>item.trim().replace(/^'|'$/g,''));
}

/** 현재 코어 어휘 객체 */
export async function nativeVocabulary(){
 return {schema:'barochart.native-vocabulary',version:1,indicators:[...builtinIndicators.keys()],drawings:[...DRAWING_TYPES],seriesTypes:await seriesTypes(),themeKeys:[...THEME_KEYS],darkTheme:{...DARK_THEME},lightTheme:{...LIGHT_THEME}};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const text=JSON.stringify(await nativeVocabulary(),null,1)+'\n';
 for(const output of VOCABULARY_OUTPUTS){await mkdir(dirname(root+output),{recursive:true});await writeFile(root+output,text);}
 console.log(JSON.stringify({written:VOCABULARY_OUTPUTS}));
}
