// 승인된 Crates.io 범위에서 고정 cbindgen을 저장소 전용 경로에 설치한다.
import {pathToFileURL} from 'node:url';
import {installCbindgen} from './cbindgen-tool.mjs';

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.exitCode=installCbindgen();
