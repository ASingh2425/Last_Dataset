/**
 * =========================================================================
 * PRODUCTION READINESS & DATABASE VERIFICATION SCRIPT
 * The Last Dataset | MAHE Manipal
 * =========================================================================
 *
 * Usage:
 *   node scripts/verify-production-state.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  console.log('========================================================');
  console.log('THE LAST DATASET — PRODUCTION READINESS AUDIT CHECK');
  console.log('========================================================\n');

  let passed = 0;
  let warnings = 0;
  let errors = 0;

  function report(type, msg) {
    if (type === 'OK') {
      console.log(`  [PASS] ${msg}`);
      passed++;
    } else if (type === 'WARN') {
      console.log(`  [WARN] ${msg}`);
      warnings++;
    } else {
      console.error(`  [FAIL] ${msg}`);
      errors++;
    }
  }

  // 1. Check migrations on disk
  console.log('--- 1. Checking Database Migration Files ---');
  const migrationFiles = [
    '001_initial_schema.sql',
    '002_atomic_ml_quota.sql',
    '003_atomic_purple_and_cap.sql',
    '004_atomic_zone_completion.sql'
  ];

  for (const mig of migrationFiles) {
    const fullPath = path.join(ROOT, 'supabase', 'migrations', mig);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      report('OK', `Migration ${mig} exists (${content.length} bytes)`);
    } else {
      report('FAIL', `Migration ${mig} is missing on disk`);
    }
  }

  // 2. Check that 001_initial_schema does NOT seed dev teams directly
  console.log('\n--- 2. Checking Production Seed Isolation ---');
  const mig001 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '001_initial_schema.sql'), 'utf8');
  if (mig001.includes("('TECHTEAM10328', 'Alpha Protocol'") || mig001.includes("'sanctuary', 'completed'")) {
    report('FAIL', '001_initial_schema.sql still contains hardcoded development teams or pre-cleared Sanctuary!');
  } else {
    report('OK', '001_initial_schema.sql is cleanly isolated from dev seed data');
  }

  const devSeed = path.join(ROOT, 'supabase', 'migrations', '000_seed_dev_data.sql');
  if (fs.existsSync(devSeed)) {
    report('OK', 'Development seeds isolated in 000_seed_dev_data.sql');
  } else {
    report('WARN', '000_seed_dev_data.sql not found');
  }

  // 3. Check Canonical Scoring
  console.log('\n--- 3. Verifying Canonical Scoring Configuration ---');
  const { CANONICAL_STAGE_SCORES, TOTAL_COMPETITION_POINTS } = require('../config/scoring');
  const expectedTotal = 100 + 200 + 400 + 600 + 800 + 1000;
  if (TOTAL_COMPETITION_POINTS === 3100 && TOTAL_COMPETITION_POINTS === expectedTotal) {
    report('OK', `Canonical game total locks to exactly ${TOTAL_COMPETITION_POINTS} points`);
  } else {
    report('FAIL', `Scoring total mismatch: expected 3,100, got ${TOTAL_COMPETITION_POINTS}`);
  }

  // 4. Check Evaluator Production Gate
  console.log('\n--- 4. Verifying Evaluator Fail-Closed Semantics ---');
  const { evaluateSubmission, _resetGroundTruth } = require('../lib/evaluator');
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
      report('OK', 'Evaluator strictly fails closed in production when ground truth is missing');
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

  // 5. Check Live Supabase Connection if configured
  console.log('\n--- 5. Checking Live Database Connection ---');
  const { supabase } = require('../lib/supabaseClient');
  if (supabase) {
    try {
      const { data: teams, error: tErr } = await supabase.from('teams').select('id, team_name').limit(5);
      if (tErr) {
        report('WARN', `Live Supabase connection returned error: ${tErr.message}`);
      } else {
        report('OK', `Live Supabase connection healthy (${teams?.length || 0} teams sampled)`);
      }
    } catch (e) {
      report('WARN', `Unable to query live Supabase: ${e.message}`);
    }
  } else {
    console.log('  [INFO] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured in current environment.');
  }

  console.log('\n========================================================');
  console.log(`AUDIT SUMMARY: ${passed} PASSED, ${warnings} WARNINGS, ${errors} ERRORS`);
  console.log('========================================================\n');

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal audit failure:', err);
  process.exit(1);
});
