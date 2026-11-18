import { getSportFromTeam, lookupTeamAccounts } from './src/services/sheets.js'
console.log('getSportFromTeam("New York Liberty") =', getSportFromTeam('New York Liberty'))
const r: any = await lookupTeamAccounts('New York Liberty')
console.log('success:', r.success, '| sport:', r.sport, '| sheetName:', r.sheetName)
if (!r.success) console.log('error:', r.error)
else {
  console.log('accounts found:', r.accounts?.length)
  console.log('headers:', r.headers)
  for (const a of (r.accounts||[]).slice(0,3)) console.log('  ', JSON.stringify(a).slice(0,160))
}
