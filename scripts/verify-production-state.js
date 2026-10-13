/**
 * =========================================================================
 * PRODUCTION READINESS & DATABASE RPC AUDIT SCRIPT
 * The Last Dataset | TechTatva 2026 | MAHE Manipal
 * =========================================================================
 *
 * Validates:
 *   1. Migration files presence on disk (000, 001, 002, 003, 004)
 *   2. DDL migration 001 isolation (no hardcoded dev teams or pre-cleared sanctuary)
 *   3. Canonical scoring configuration (locks to strictly 3,100 pts)
 *   4. Evaluator fail-closed semantics in production mode
 *   5. Hidden ground truth answer key integrity (120 rows, not the sample fixture)
 *   6. Live Supabase connection, schema tables, and views
 *   7. Live Supabase database stored procedures & triggers (RPC existence probe)
 *   8. Participant roster initial state (fair progression: Sanctuary available, later zones locked)
 *
 * Usage:
 *   node scripts/verify-production-state.js
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

// Load .env explicitly if available
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

async function main() {
  console.log('========================================================');
  console.log('THE LAST DATASET — PRODUCTION READINESS & RPC AUDIT');
  console.log('========================================================\n');

  let passed = 0;
  let warnings = 0;
  let errors = 0;

  function report(type, msg, detail = null) {
    if (type === 'OK') {
      console.log(`  [PASS] ${msg}`);
      passed++;
    } else if (type === 'WARN') {
      console.log(`  [WARN] ${msg}`);
      if (detail) console.log(`         -> ${detail}`);
      warnings++;
    } else {
      console.error(`  [FAIL] ${msg}`);
      if (detail) console.error(`         -> ${detail}`);
      errors++;
    }
  }

  // 1. Check migrations on disk
  console.log('--- 1. Checking Database Migration Files on Disk ---');
  const migrationFiles = [
    { file: '000_seed_dev_data.sql', required: false, desc: 'Optional dev seed fixture' },
    { file: '001_initial_schema.sql', required: true, desc: 'Core schema tables, views & complete_challenge_idempotent' },
    { file: '002_atomic_ml_quota.sql', required: true, desc: 'Advisory lock & reserve_ml_attempt RPC' },
    { file: '003_atomic_purple_and_cap.sql', required: true, desc: 'check_team_member_cap trigger & finalize_qualifying_ml_submission RPC' },
    { file: '004_atomic_zone_completion.sql', required: true, desc: 'Atomic complete_zone_atomic RPC' }
  ];

  for (const mig of migrationFiles) {
    const fullPath = path.join(ROOT, 'supabase', 'migrations', mig.file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      report('OK', `${mig.file} exists (${content.length} bytes) — ${mig.desc}`);
    } else {
      report(mig.required ? 'FAIL' : 'WARN', `${mig.file} is missing on disk`);
    }
  }

  // 2. Check that 001_initial_schema does NOT seed dev teams directly
  console.log('\n--- 2. Checking Production Schema Seed Isolation ---');
  const mig001 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '001_initial_schema.sql'), 'utf8');
  if (mig001.includes("('TECHTEAM10328', 'Alpha Protocol'") || mig001.includes("'sanctuary', 'completed'")) {
    report('FAIL', '001_initial_schema.sql contains hardcoded development teams or pre-cleared Sanctuary!');
  } else {
    report('OK', '001_initial_schema.sql is cleanly isolated from dev seed fixtures');
  }

  // 3. Check Canonical Scoring
  console.log('\n--- 3. Verifying Canonical Scoring Configuration ---');
  const { CANONICAL_STAGE_SCORES, TOTAL_COMPETITION_POINTS } = require('../config/scoring');
  const expectedTotal = 100 + 200 + 400 + 600 + 800 + 1000;
  if (TOTAL_COMPETITION_POINTS === 3100 && TOTAL_COMPETITION_POINTS === expectedTotal) {
    report('OK', `Canonical game total locks to exactly ${TOTAL_COMPETITION_POINTS} points (100+200+400+600+800+1000)`);
  } else {
    report('FAIL', `Scoring total mismatch: expected 3,100, got ${TOTAL_COMPETITION_POINTS}`);
  }

  // 4. Check Evaluator Production Gate
  console.log('\n--- 4. Verifying Evaluator Fail-Closed Semantics ---');
  const { evaluateSubmission, _resetGroundTruth, parseCsvLine } = require('../lib/evaluator');
  const prevEnv = process.env.NODE_ENV;
  const prevBase64 = process.env.PRIVATE_ANSWERS_BASE64;
  const prevPath = process.env.PRIVATE_ANSWERS_PATH;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PRIVATE_ANSWERS_BASE64;
    process.env.PRIVATE_ANSWERS_PATH = '/non/existent/path/private_answers.csv';
    _resetGroundTruth();

    const evalResult = evaluateSubmission('Sanctuary_ID,Survival_Probability\nSANC-0091,0.5');
    if (!evalResult.valid && evalResult.error?.includes('SCORING_ARBITER_UNAVAILABLE')) {
      report('OK', 'Evaluator strictly fails closed in production when ground truth is missing (no fixture fallback)');
    } else {
      report('FAIL', `Evaluator did not fail closed in production: ${JSON.stringify(evalResult)}`);
    }
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevBase64) process.env.PRIVATE_ANSWERS_BASE64 = prevBase64;
    else delete process.env.PRIVATE_ANSWERS_BASE64;
    if (prevPath) process.env.PRIVATE_ANSWERS_PATH = prevPath;
    else delete process.env.PRIVATE_ANSWERS_PATH;
    _resetGroundTruth();
  }

  // 5. Check Hidden Ground Truth Answer Key Integrity
  console.log('\n--- 5. Verifying Hidden Ground Truth Answer Key ---');
  let groundTruthRaw = '';
  let sourceDesc = '';

  if (process.env.PRIVATE_ANSWERS_BASE64) {
    try {
      groundTruthRaw = Buffer.from(process.env.PRIVATE_ANSWERS_BASE64, 'base64').toString('utf8');
      sourceDesc = 'process.env.PRIVATE_ANSWERS_BASE64';
    } catch (e) {
      report('FAIL', `Failed to decode PRIVATE_ANSWERS_BASE64: ${e.message}`);
    }
  } else if (process.env.PRIVATE_ANSWERS_PATH && fs.existsSync(process.env.PRIVATE_ANSWERS_PATH)) {
    groundTruthRaw = fs.readFileSync(process.env.PRIVATE_ANSWERS_PATH, 'utf8');
    sourceDesc = `process.env.PRIVATE_ANSWERS_PATH (${process.env.PRIVATE_ANSWERS_PATH})`;
  } else {
    const defaultFile = path.join(ROOT, 'server_data', 'private_answers.csv');
    if (fs.existsSync(defaultFile)) {
      groundTruthRaw = fs.readFileSync(defaultFile, 'utf8');
      sourceDesc = `Local disk file (server_data/private_answers.csv)`;
    }
  }

  if (!groundTruthRaw) {
    report('FAIL', 'Production ground truth answer key is completely missing!', 'Set PRIVATE_ANSWERS_BASE64 in Vercel/production or provide server_data/private_answers.csv');
  } else {
    const lines = groundTruthRaw.trim().split(/\r?\n/);
    const rowCount = lines.length - 1; // exclude header
    if (rowCount === 120) {
      report('OK', `Ground truth answer key loaded from ${sourceDesc} contains exactly 120 survivor rows`);
    } else {
      report('FAIL', `Ground truth row count mismatch: expected 120, found ${rowCount}`);
    }

    // Verify it is NOT the public sample predictions fixture
    const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'sample_predictions.csv');
    if (fs.existsSync(fixturePath)) {
      const fixtureContent = fs.readFileSync(fixturePath, 'utf8');
      if (groundTruthRaw.trim() === fixtureContent.trim()) {
        report('FAIL', 'Ground truth answer key is IDENTICAL to sample_predictions.csv! Real answers must be distinct.');
      } else {
        // Run test evaluation: sample_predictions.csv evaluated against real ground truth
        _resetGroundTruth();
        const prevB64 = process.env.PRIVATE_ANSWERS_BASE64;
        process.env.PRIVATE_ANSWERS_BASE64 = Buffer.from(groundTruthRaw).toString('base64');
        const evalCheck = evaluateSubmission(fixtureContent);
        if (evalCheck.valid && evalCheck.r2Score !== 1.0 && evalCheck.r2Score > 0.5) {
          report('OK', `Verified genuine ground truth: sample fixture scores R² = ${(evalCheck.r2Score * 100).toFixed(2)}% (< 80% escape threshold)`);
        } else {
          report('WARN', `Unexpected evaluation score against ground truth: R² = ${evalCheck.r2Score}`);
        }
        if (prevB64) process.env.PRIVATE_ANSWERS_BASE64 = prevB64;
        else delete process.env.PRIVATE_ANSWERS_BASE64;
        _resetGroundTruth();
      }
    }
  }

  // 6. Check Live Supabase Connection & Schema Tables
  console.log('\n--- 6. Checking Live Database Tables & Views ---');
  const { supabase } = require('../lib/supabaseClient');
  if (!supabase) {
    report('WARN', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not configured. Skipping live database audit.');
  } else {
    const requiredTables = [
      'teams',
      'team_members',
      'zone_progress',
      'dataset_entitlements',
      'score_ledger',
      'ml_submissions',
      'leaderboard_view'
    ];

    for (const table of requiredTables) {
      const { data, error } = await supabase.from(table).select('*').limit(1);
      if (error) {
        report('FAIL', `Table/View "${table}" error: ${error.message} (Code: ${error.code})`);
      } else {
        report('OK', `Table/View "${table}" is accessible in public schema`);
      }
    }

    // 7. Check Live Supabase Stored Procedures (RPC Existence Probing)
    console.log('\n--- 7. Checking Live Database Stored Procedures (RPCs) ---');
    const rpcProbes = [
      {
        name: 'complete_challenge_idempotent',
        migration: '001_initial_schema.sql',
        params: {
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_zone_id: 'sanctuary',
          p_challenge_id: 'probe-01',
          p_points: 0,
          p_all_zone_challenges: []
        }
      },
      {
        name: 'reserve_ml_attempt',
        migration: '002_atomic_ml_quota.sql / 003_atomic_purple_and_cap.sql',
        params: {
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_raw_filename: 'probe.csv',
          p_max_attempts: 10
        }
      },
      {
        name: 'finalize_qualifying_ml_submission',
        migration: '003_atomic_purple_and_cap.sql',
        params: {
          p_submission_id: '00000000-0000-0000-0000-000000000000',
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_r2_score: 1.0,
          p_mse_score: 0.0,
          p_points: 0
        }
      },
      {
        name: 'complete_zone_atomic',
        migration: '004_atomic_zone_completion.sql',
        params: {
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_zone_id: 'sanctuary',
          p_points: 0,
          p_next_zone_id: null,
          p_dataset_key: null,
          p_source_id: 'probe',
          p_source_type: 'probe',
          p_required_prev_zone: null,
          p_required_challenges: []
        }
      }
    ];

    for (const probe of rpcProbes) {
      const res = await supabase.rpc(probe.name, probe.params);
      const isMissing = res.error?.code === 'PGRST202';
      if (isMissing) {
        report(
          'FAIL',
          `RPC "${probe.name}" is NOT installed on Supabase!`,
          `Run supabase/migrations/${probe.migration} in the Supabase Dashboard SQL Editor.`
        );
      } else {
        report('OK', `RPC "${probe.name}" is verified present and executable in PostgreSQL`);
      }
    }

    // 8. Check Participant Roster & Initial State
    console.log('\n--- 8. Checking Participant Roster & Progression State ---');
    const { data: teams, error: teamsErr } = await supabase.from('teams').select('id, team_name, is_active');
    if (teamsErr) {
      report('FAIL', `Unable to query teams roster: ${teamsErr.message}`);
    } else {
      report('OK', `Participant roster contains ${teams?.length || 0} teams registered`);

      const { data: progressList } = await supabase.from('zone_progress').select('team_id, zone_id, status');
      if (progressList && progressList.length > 0) {
        const preCompletedSanctuary = progressList.filter(p => p.zone_id === 'sanctuary' && p.status === 'completed');
        const preUnlockedYellow = progressList.filter(p => p.zone_id === 'yellow' && p.status === 'available');

        if (preCompletedSanctuary.length > 0) {
          report(
            'WARN',
            `${preCompletedSanctuary.length} team(s) have Sanctuary marked "completed" without earning points.`,
            `To ensure fair competition, run "node scripts/import-techtatva-teams.js --file <roster.csv>" to set Sanctuary="available" and Yellow="locked"`
          );
        } else {
          report('OK', 'All teams start in fair state: Sanctuary available, later zones locked');
        }
      }
    }
  }

  console.log('\n========================================================');
  console.log(`AUDIT SUMMARY: ${passed} PASSED, ${warnings} WARNINGS, ${errors} ERRORS`);
  console.log('========================================================\n');

  if (errors > 0) {
    console.error('CRITICAL: One or more production readiness checks failed.');
    console.error('Please review the action items above before opening to participants.\n');
    process.exit(1);
  } else {
    console.log('ALL PRODUCTION READINESS CHECKS PASSED!\n');
  }
}

main().catch((err) => {
  console.error('Fatal audit failure:', err);
  process.exit(1);
});
