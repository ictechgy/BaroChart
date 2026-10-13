/** Verify a successful Android ps inventory without touching any other process.
 * Return command evidence for finalizePressureCompletion's required cleanup.
 */
export function confirmOwnedPackageAbsent(response,pkg){
 const result={...response,error:response?.error??null};
 if(result.status!==0||result.error!==null||result.signal!=null)return result;
 const rows=String(result.stdout??'').trim().split(/\r?\n/);
 if(!/^\s*PID\s+NAME\s*$/.test(rows.shift()??'')){
  result.error='Unrecognized Android process inventory header';return result;
 }
 const owned=[];
 for(const row of rows){
  if(!row.trim())continue;
  const match=row.match(/^\s*(\d+)\s+(\S+)\s*$/);
  if(!match){result.error='Malformed Android process inventory row';return result;}
  if(match[2]===pkg||match[2].startsWith(pkg+':'))owned.push({pid:Number(match[1]),name:match[2]});
 }
 if(owned.length)result.error='Owned package process remains: '+JSON.stringify(owned);
 return result;
}
