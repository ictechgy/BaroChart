import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

// Internal tooling only. The optional I/O seam permits deterministic failure
// tests; production calls use the real filesystem and preserve its errors.
export async function writePackageVerificationReport(output,result,io={mkdir,writeFile}){
 await io.mkdir(dirname(output),{recursive:true});
 await io.writeFile(output,JSON.stringify(result,null,2)+'\n');
}
