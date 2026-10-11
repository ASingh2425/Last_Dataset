const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

async function runTests() {
  console.log('====================================================');
  console.log('STARTING THE LAST DATASET END-TO-END SYSTEM TESTS');
  console.log('====================================================');

  const server = createHubServer();
  await new Promise((resolve) => server.listen(4199, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:4199';
  console.log(`Test server running at ${baseUrl}`);

  // Test state isolation: Clean up previous test run data for TECHTEAM10328
  const { supabase } = require('../lib/supabaseClient');
  await supabase.from('score_ledger').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('dataset_entitlements').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('ml_submissions').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('zone_progress').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('zone_progress').insert([
    { team_id: 'TECHTEAM10328', zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
    { team_id: 'TECHTEAM10328', zone_id: 'yellow', status: 'locked', unlocked_at: null }
  ]);

  let testPassed = 0;
  let testFailed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      testPassed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      testFailed++;
    }
  }

  let sessionCookie = '';

  try {
    // 1. Test Health Endpoint
    console.log('\n--- 1. Testing /api/health ---');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = await healthRes.json();
    assert(healthRes.status === 200, 'Health endpoint returns 200');
    assert(healthJson.database === 'supabase-postgresql', 'Health reports supabase-postgresql database');

    // 2. Test Unauthenticated Bootstrap
    console.log('\n--- 2. Testing /api/bootstrap (Unauthenticated) ---');
    const unauthRes = await fetch(`${baseUrl}/api/bootstrap`);
    const unauthJson = await unauthRes.json();
    assert(unauthJson.authenticated === false, 'Unauthenticated user gets authenticated=false');
    assert(unauthJson.zones.length === 5, 'Returns 5 zones definition');

    // 3. Test Invalid Login Attempts
    console.log('\n--- 3. Testing Authentication Security Boundaries ---');
    // Wrong team
    const badTeamRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM99999', delegateId: '12331', passcode: 'MAHE2026!' })
    });
    assert(badTeamRes.status === 401, 'Non-existent Team ID returns 401');

    // Wrong passcode
    const badPassRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM10328', delegateId: '12331', passcode: 'WRONG_PASS' })
    });
    assert(badPassRes.status === 401, 'Wrong password returns 401');

    // Wrong delegate
    const badDelRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM10328', delegateId: '99999', passcode: 'MAHE2026!' })
    });
    assert(badDelRes.status === 401, 'Unregistered delegate ID returns 401');

    // 4. Test Valid Player Login (Player 1: 12331)
    console.log('\n--- 4. Testing Valid Player Login (Player 1) ---');
    const validLoginRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM10328', delegateId: '12331', passcode: 'MAHE2026!' })
    });
    const loginJson = await validLoginRes.json();
    assert(validLoginRes.status === 200, 'Valid login returns 200');
    assert(loginJson.authenticated === true, 'Returns authenticated=true');
    assert(loginJson.team.id === 'TECHTEAM10328', 'Returns team ID TECHTEAM10328');
    assert(loginJson.team.name === 'Alpha Protocol', 'Returns verified team name Alpha Protocol');
    assert(loginJson.player.delegateId === '12331', 'Identifies active operator 12331');

    const rawCookie = validLoginRes.headers.get('set-cookie');
    assert(!!rawCookie && rawCookie.includes('td_session='), 'Sets HttpOnly td_session cookie');
    sessionCookie = rawCookie.split(';')[0];

    // 5. Test Authenticated Bootstrap with Cookie
    console.log('\n--- 5. Testing Authenticated /api/bootstrap ---');
    const authBootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Cookie: sessionCookie }
    });
    const authBootJson = await authBootRes.json();
    assert(authBootJson.authenticated === true, 'Session cookie restores authentication');
    assert(authBootJson.score !== undefined, 'Returns authoritative score');
    assert(authBootJson.zones[0].unlocked === false, 'Yellow zone is initially locked until Sanctuary is completed');
    assert(authBootJson.zones.every((z) => z.unlocked === false), 'All quarantine zones are initially locked upon login');

    // 5.1 Test Sanctuary Completion unlocks Yellow Zone
    console.log('\n--- 5.1 Testing Sanctuary Storyline Completion ---');
    const sancRes = await fetch(`${baseUrl}/api/sanctuary/complete`, {
      method: 'POST',
      headers: { Cookie: sessionCookie }
    });
    assert(sancRes.status === 200, 'Sanctuary completion endpoint returns 200');
    const sancBoot = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: sessionCookie } })).json();
    assert(sancBoot.zones[0].unlocked === true, 'Yellow zone is unlocked after Sanctuary storyline completion');

    // 6. Test Dataset Entitlement Security (Before Solve)
    console.log('\n--- 6. Testing Dataset Entitlement Gate (Before Clearing Zone) ---');
    // Training set should NOT be accessible until Purple Zone is unlocked
    const trainRes = await fetch(`${baseUrl}/api/dataset/train`, {
      headers: { Cookie: sessionCookie }
    });
    assert(trainRes.status === 403, 'train.csv is 403 Forbidden until Purple Zone is unlocked');

    // Yellow reward (community_final) should NOT be accessible yet
    const lockedDatasetRes = await fetch(`${baseUrl}/api/dataset/community_final`, {
      headers: { Cookie: sessionCookie }
    });
    assert(lockedDatasetRes.status === 403, 'community_final.csv is 403 Forbidden before zone is cleared');

    // 7. Test Concurrency & Idempotency (Atomic Multi-Player Challenge Solve)
    console.log('\n--- 7. Testing Atomic Multi-Player Concurrency & Idempotency ---');
    // Simulate both teammates solving yellow-01 concurrently
    const [solve1, solve2] = await Promise.all([
      fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ ctfId: 'yellow-01' })
      }),
      fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ ctfId: 'yellow-01' })
      })
    ]);

    const solve1Json = await solve1.json();
    const solve2Json = await solve2.json();

    assert(solve1.status === 200 && solve2.status === 200, 'Both concurrent solve requests return 200');
    const newSolveCount = (solve1Json.rpcResult?.newlySolved ? 1 : 0) + (solve2Json.rpcResult?.newlySolved ? 1 : 0);
    assert(newSolveCount === 1, `Points were awarded exactly once (newlySolved=true on only 1 request, got ${newSolveCount})`);

    // 8. Verify Zone Completion & Dataset Entitlement Unlock (Yellow Zone cleared on yellow-01)
    console.log('\n--- 8. Testing Zone Completion & Dataset Entitlement Unlock ---');

    // Now community_final dataset should be unlocked and downloadable!
    const unlockedDatasetRes = await fetch(`${baseUrl}/api/dataset/community_final`, {
      headers: { Cookie: sessionCookie }
    });
    assert(unlockedDatasetRes.status === 200, 'community_final.csv is now 200 OK after Yellow Zone clear');
    const datasetCsv = await unlockedDatasetRes.text();
    assert(datasetCsv.includes('Sanctuary_ID') && datasetCsv.includes('SANC-0001'), 'Downloaded CSV contains valid survivor data');

    // Verify Blue Zone is now unlocked
    const nextBootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Cookie: sessionCookie }
    });
    const nextBootJson = await nextBootRes.json();
    assert(nextBootJson.zones[1].unlocked === true, 'Blue Zone is unlocked automatically following Yellow Zone clear');
    assert(nextBootJson.score.total >= 20, `Team score updated accurately (Total: ${nextBootJson.score.total} pts)`);

    // 9. Test Purple Zone Server-Side ML Evaluator
    console.log('\n--- 9. Testing Purple Zone Server-Side ML Evaluator ---');
    const samplePreds = fs.readFileSync('c:/Users/Anvesha/OneDrive/Desktop/LAST DATASET/survival_predictions_catboost_elasticnet.csv', 'utf8');

    const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ csvContent: samplePreds, rawFilename: 'catboost_test.csv' })
    });
    const evalJson = await evalRes.json();
    assert(evalRes.status === 200, 'ML evaluation endpoint returns 200 for valid predictions');
    assert(evalJson.r2Score === 0.7754, `Calculated accurate R² score against hidden ground truth (R² = ${evalJson.r2Score})`);
    assert(evalJson.qualifiesForEscape === false, '0.7754 does not unlock escape gate (< 0.80)');

    // Test with perfect answer key
    const perfectKey = fs.readFileSync('server_data/private_answers.csv', 'utf8');
    const perfectRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ csvContent: perfectKey, rawFilename: 'perfect.csv' })
    });
    const perfectJson = await perfectRes.json();
    assert(perfectJson.r2Score === 1.0, 'Perfect answers score R² = 1.0');
    assert(perfectJson.qualifiesForEscape === true, 'R² >= 0.80 unlocks the Escape Gate (qualifiesForEscape=true)');

    // 10. Test Leaderboard
    console.log('\n--- 10. Testing Live Leaderboard ---');
    const leadRes = await fetch(`${baseUrl}/api/leaderboard`);
    const leadJson = await leadRes.json();
    assert(leadRes.status === 200, 'Leaderboard endpoint returns 200');
    assert(Array.isArray(leadJson.leaderboard), 'Returns leaderboard array');
    const topTeam = leadJson.leaderboard.find((t) => t.team_id === 'TECHTEAM10328');
    assert(!!topTeam && topTeam.escape_unlocked === true, 'Leaderboard accurately reflects team score and escape status');

  } catch (err) {
    console.error('Test Suite Exception:', err);
    testFailed++;
  } finally {
    // Reset TECHTEAM10328 back to pristine starting state
    await supabase.from('score_ledger').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('dataset_entitlements').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('ml_submissions').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('team_sessions').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('zone_progress').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('zone_progress').insert([
      { team_id: 'TECHTEAM10328', zone_id: 'sanctuary', status: 'completed', unlocked_at: new Date().toISOString() },
      { team_id: 'TECHTEAM10328', zone_id: 'yellow', status: 'available', unlocked_at: new Date().toISOString() },
      { team_id: 'TECHTEAM10328', zone_id: 'blue', status: 'locked' },
      { team_id: 'TECHTEAM10328', zone_id: 'orange', status: 'locked' },
      { team_id: 'TECHTEAM10328', zone_id: 'red', status: 'locked' },
      { team_id: 'TECHTEAM10328', zone_id: 'purple', status: 'locked' }
    ]);
    server.close();
    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${testPassed} PASSED, ${testFailed} FAILED`);
    console.log('====================================================');
    process.exit(testFailed > 0 ? 1 : 0);
  }
}

runTests();
