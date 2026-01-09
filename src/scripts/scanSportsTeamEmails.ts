/**
 * Sports Team Email Scanner Script
 *
 * Scans Gmail for all emails with sports team labels (NBA/, MLB/, NFL/, etc.)
 * and extracts unique "from" addresses for each team.
 *
 * Usage:
 *   npx ts-node src/scripts/scanSportsTeamEmails.ts
 *
 * Options (via environment variables):
 *   MAX_EMAILS_PER_LABEL - Max emails to fetch per team label (default: 500)
 *   OUTPUT_FORMAT - Output format: "json" or "table" (default: "table")
 */

import { scanSportsTeamEmails, type SportsTeamScanResult } from '../services/presaleScanner.js';

// ============================================================================
// Configuration
// ============================================================================

const MAX_EMAILS_PER_LABEL = parseInt(process.env.MAX_EMAILS_PER_LABEL ?? '500', 10);
const OUTPUT_FORMAT = process.env.OUTPUT_FORMAT ?? 'table';

// ============================================================================
// Output Formatters
// ============================================================================

function printTable(result: SportsTeamScanResult): void {
  console.log('\n' + '='.repeat(80));
  console.log('SPORTS TEAM EMAIL SCAN RESULTS');
  console.log('='.repeat(80));
  console.log(`Scanned at: ${result.scannedAt}`);
  console.log(`Total labels: ${result.totalLabels}`);
  console.log(`Total unique addresses: ${result.totalUniqueAddresses}`);
  console.log('='.repeat(80) + '\n');

  // Group by sport
  const bySport = new Map<string, typeof result.teams>();
  for (const team of result.teams) {
    const sportTeams = bySport.get(team.sport) ?? [];
    sportTeams.push(team);
    bySport.set(team.sport, sportTeams);
  }

  for (const [sport, teams] of bySport) {
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`${sport}`);
    console.log('─'.repeat(40));

    for (const team of teams) {
      console.log(`\n  ${team.team} (${team.emailCount} emails scanned)`);
      console.log(`  ${'─'.repeat(36)}`);

      if (team.fromAddresses.length === 0) {
        console.log('    (no emails found)');
      } else {
        for (const addr of team.fromAddresses) {
          console.log(`    ${addr}`);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY BY SPORT');
  console.log('='.repeat(80));

  for (const [sport, teams] of bySport) {
    const totalAddresses = new Set(teams.flatMap(t => t.fromAddresses)).size;
    const totalEmails = teams.reduce((sum, t) => sum + t.emailCount, 0);
    console.log(`  ${sport}: ${teams.length} teams, ${totalAddresses} unique addresses, ${totalEmails} emails`);
  }
}

function printJson(result: SportsTeamScanResult): void {
  console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting sports team email scan...');
  console.log(`Max emails per label: ${MAX_EMAILS_PER_LABEL}`);
  console.log(`Output format: ${OUTPUT_FORMAT}`);

  try {
    const result = await scanSportsTeamEmails(MAX_EMAILS_PER_LABEL);

    if (OUTPUT_FORMAT === 'json') {
      printJson(result);
    } else {
      printTable(result);
    }

    console.log('\nScan complete!');
  } catch (error) {
    console.error('Scan failed:', error);
    process.exit(1);
  }
}

// Run if called directly
main();
