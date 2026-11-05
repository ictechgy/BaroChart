import type {RustScene} from './chart.mjs';
export function decodeRustPacket(packet:{metadata:unknown;numbers:Float64Array}):{mode:'scene'|'frame';width:number;height:number;background:string;stats:Record<string,number>;layers:(RustScene|null)[]};
