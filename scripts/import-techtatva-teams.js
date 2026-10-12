/**
 * =========================================================================
 * TECHTATVA PARTICIPANT IMPORTER SCRIPT
 * The Last Dataset | MAHE Manipal
 * =========================================================================
 *
 * Usage:
 *   node scripts/import-techtatva-teams.js --file ./participants.csv [--dry-run]
 *
 * Supports columns from the official portal export:
 *   - "Team ID" (e.g. TECHTEAM10328)
 *   - "Delegate ID" (e.g. 12331)
 *   - "Team Leader" (e.g. GRANDHI GOWTHAM RAM SAI)
 *   - "Mobile No." (e.g. 8431863119)
 *   - "Student Type" (e.g. MAHE / NONMAHE)
 *   - "Team Type" (e.g. Team)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { supabase } = require('../lib/supabaseClient');

function hashPassword(passcode) {
  return crypto.createHash('sha256').update(String(passcode).trim(), 'utf8').digest('hex');
}

function generateRandomPasscode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'TLD-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parser handling quotes
    const values = [];
    let insideQuotes = false;
    let currentVal = '';

    for (let c = 0; c < lines[i].length; c++) {
      const char = lines[i][c];
      if (char === '"' || char === "'") {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        values.push(currentVal.trim().replace(/^["']|["']$/g, ''));
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
    values.push(currentVal.trim().replace(/^["']|["']$/g, ''));

    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] || '';
    });
    rows.push(obj);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const fileArgIndex = args.indexOf('--file');
  const filePath = fileArgIndex !== -1 ? args[fileArgIndex + 1] : null;

  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Error: Please provide a valid CSV file path via --file <path>');
    console.log('Example: node scripts/import-techtatva-teams.js --file ./participants.csv --dry-run');
    process.exit(1);
  }

  console.log(`Reading registration file: ${filePath}`);
  const csvContent = fs.readFileSync(filePath, 'utf8');
  const rawRows = parseCSV(csvContent);

  console.log(`Parsed ${rawRows.length} participant records.`);
  if (!rawRows.length) {
    console.log('No records found in CSV.');
    return;
  }

  // Find column keys flexibly
  const sample = rawRows[0];
  const teamIdKey = Object.keys(sample).find((k) => k.includes('team id') || k === 'team_id' || k === 'teamid');
  const delegateIdKey = Object.keys(sample).find((k) => k.includes('delegate') || k === 'delegate_id');
  const leaderKey = Object.keys(sample).find((k) => k.includes('leader') || k.includes('name'));
  const mobileKey = Object.keys(sample).find((k) => k.includes('mobile') || k.includes('phone'));
  const studentTypeKey = Object.keys(sample).find((k) => k.includes('student type') || k.includes('type'));

  if (!teamIdKey || !delegateIdKey) {
    console.error('Error: Could not locate required "Team ID" and "Delegate ID" columns in CSV header.');
    console.log('Available columns:', Object.keys(sample));
    process.exit(1);
  }

  // Group by Team ID (up to 2 players per team)
  const teamsMap = new Map();

  for (const row of rawRows) {
    const rawTeamId = String(row[teamIdKey] || '').trim().toUpperCase();
    const rawDelegateId = String(row[delegateIdKey] || '').trim();
    if (!rawTeamId || !rawDelegateId) continue;

    if (!teamsMap.has(rawTeamId)) {
      const leaderName = leaderKey ? String(row[leaderKey] || '').trim() : 'Survivor Leader';
      const mobile = mobileKey ? String(row[mobileKey] || '').trim() : '0000000000';
      const studentType = studentTypeKey ? String(row[studentTypeKey] || '').trim() : 'MAHE';

      teamsMap.set(rawTeamId, {
        teamId: rawTeamId,
        teamName: `Team ${rawTeamId.replace(/^TECHTEAM/, '')}`,
        leaderName,
        mobile,
        studentType,
        passcode: generateRandomPasscode(),
        members: []
      });
    }

    const teamEntry = teamsMap.get(rawTeamId);
    const memberName = leaderKey ? String(row[leaderKey] || '').trim() : `Player ${rawDelegateId}`;
    teamEntry.members.push({
      delegateId: rawDelegateId,
      name: memberName,
      isLeader: teamEntry.members.length === 0
    });
  }

  console.log(`\nIdentified ${teamsMap.size} distinct teams across ${rawRows.length} participants.`);

  // Summary preview
  console.log('\n--- PREVIEW OF TEAMS TO IMPORT ---');
  let previewCount = 0;
  for (const team of teamsMap.values()) {
    if (previewCount++ < 5) {
      console.log(`  Team: ${team.teamId} | Leader: ${team.leaderName} | Mobile: ${team.mobile} | Passcode: ${team.passcode} | Members (${team.members.length}): ${team.members.map(m => m.delegateId).join(', ')}`);
    }
  }
  if (teamsMap.size > 5) {
    console.log(`  ... and ${teamsMap.size - 5} more teams.`);
  }

  if (isDryRun) {
    console.log('\n[DRY RUN COMPLETE] No changes were written to Supabase database.');
    return;
  }

  console.log('\nWriting teams to Supabase PostgreSQL database...');
  let importedTeams = 0;
  let importedMembers = 0;

  for (const team of teamsMap.values()) {
    const passHash = hashPassword(team.passcode);

    // Upsert team
    const { error: teamErr } = await supabase.from('teams').upsert({
      id: team.teamId,
      team_name: team.teamName,
      team_leader_name: team.leaderName,
      leader_mobile: team.mobile,
      passcode_hash: passHash,
      student_type: team.studentType,
      is_active: true
    }, { onConflict: 'id' });

    if (teamErr) {
      console.error(`Failed to insert team ${team.teamId}:`, teamErr.message);
      continue;
    }
    importedTeams++;

    // Insert members
    for (const member of team.members) {
      const { error: memErr } = await supabase.from('team_members').upsert({
        delegate_id: member.delegateId,
        team_id: team.teamId,
        member_name: member.name,
        is_leader: member.isLeader
      }, { onConflict: 'delegate_id' });

      if (!memErr) importedMembers++;
    }

    // Initialize sanctuary as available and yellow as locked for fair progression
    await supabase.from('zone_progress').upsert([
      { team_id: team.teamId, zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
      { team_id: team.teamId, zone_id: 'yellow', status: 'locked', unlocked_at: null }
    ], { onConflict: 'team_id,zone_id' });
  }

  console.log(`\nSUCCESSFULLY IMPORTED: ${importedTeams} teams and ${importedMembers} members into live database!`);
}

main().catch(console.error);
