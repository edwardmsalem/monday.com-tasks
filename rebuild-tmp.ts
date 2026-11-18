import { assignPacks } from './src/services/sheets.js'
import fs from 'fs'
const cur = JSON.parse(fs.readFileSync('/tmp/scan_full.json','utf8')) as string[][]
const lib = JSON.parse(fs.readFileSync('/tmp/liberty.json','utf8')) as string[][]
const header = cur[0]
const LH: Record<string,number> = {}; lib[0].forEach((h,i)=>LH[String(h).trim()]=i)
const g=(r:string[],k:string)=>{const i=LH[k]; return i!==undefined && i<r.length ? String(r[i]).trim() : ''}
const by=new Map<string,string[][]>()
for (const r of lib.slice(1)){const em=g(r,'Email').toLowerCase(); if(!em)continue; if(!by.has(em))by.set(em,[]); by.get(em)!.push(r)}
const order:{d:string;t:string;em:string;notes:string}[]=[]; const seen=new Set<string>()
for (const r of cur.slice(1)){const em=(r[2]||'').trim(); if(!em)continue; const k=em.toLowerCase(); if(seen.has(k))continue; seen.add(k); order.push({d:r[0]||'',t:r[1]||'',em,notes:(r[19]||'')})}
const out:string[][]=[header]
for(const a of order){
  const accts=by.get(a.em.toLowerCase())||[]
  if(!accts.length){out.push([a.d,a.t,a.em,'','','','','','','','','','','','','','','','',a.notes]);continue}
  for(const r of accts) out.push([a.d,a.t,a.em,'',g(r,'Name'),g(r,'Option'),g(r,'Section'),g(r,'Row'),g(r,'Low Seat'),g(r,'High Seat'),g(r,'Qty'),'','',g(r,'RS Total'),g(r,'Last 4'),g(r,'Exp'),g(r,'CVC'),g(r,'Address'),g(r,'Status'),a.notes])
}
const body=out.slice(1)
assignPacks(body as any,6,7,8,9,11,2,12)
while(out.length<cur.length) out.push(new Array(header.length).fill(''))
fs.writeFileSync('/tmp/corrected20.json',JSON.stringify(out))
console.log(`recipients=${order.length} dataRows=${body.filter(r=>r[2]).length} packs=${new Set(body.map(r=>r[11]).filter(Boolean)).size} rowsWritten=${out.length}`)
console.log('\nSAMPLE (Date|Time|Email|Name|Plan|Sec|Row|Lo|Hi|Qty|Pack|Total|Last4|Exp|CVV):')
for(const r of body.slice(0,5)) console.log('  '+[r[0],r[1],String(r[2]).slice(0,24),r[4],r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[13],r[14],r[15],r[16]].join(' | '))
