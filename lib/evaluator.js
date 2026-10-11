const fs = require('node:fs');
const path = require('node:path');

const PRIVATE_ANSWERS_PATH = path.resolve(__dirname, '..', 'server_data', 'private_answers.csv');
const ESCAPE_THRESHOLD = 0.80; // Qualifying R2 threshold for Escape Gate

let groundTruthMap = null;
let groundTruthStats = null;

function loadGroundTruth() {
  if (groundTruthMap) return { groundTruthMap, groundTruthStats };

  if (!fs.existsSync(PRIVATE_ANSWERS_PATH)) {
    throw new Error(`Private answers file not found at ${PRIVATE_ANSWERS_PATH}`);
  }

  const content = fs.readFileSync(PRIVATE_ANSWERS_PATH, 'utf8');
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const map = new Map();
  let sumY = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 2) {
      const id = parts[0].trim();
      const val = parseFloat(parts[1]);
      if (id && !isNaN(val)) {
        map.set(id, val);
        sumY += val;
      }
    }
  }

  const n = map.size;
  if (n !== 120) {
    throw new Error(`Expected 120 ground truth rows, found ${n}`);
  }

  const meanY = sumY / n;
  let ssTot = 0;
  for (const y of map.values()) {
    ssTot += Math.pow(y - meanY, 2);
  }

  groundTruthMap = map;
  groundTruthStats = { n, meanY, ssTot };
  return { groundTruthMap, groundTruthStats };
}

/**
 * Validates and evaluates an uploaded submission CSV string.
 */
function evaluateSubmission(csvContent, options = {}) {
  const { groundTruthMap, groundTruthStats } = loadGroundTruth();
  const qualifyingThreshold = options.threshold !== undefined ? options.threshold : ESCAPE_THRESHOLD;

  if (typeof csvContent !== 'string' || !csvContent.trim()) {
    return { valid: false, error: 'Empty or missing submission file.' };
  }

  const lines = csvContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { valid: false, error: 'File must contain a header and prediction rows.' };
  }

  // 1. Validate Header
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idIndex = header.findIndex((h) => h === 'sanctuary_id');
  const predIndex = header.findIndex((h) => h === 'survival_probability');

  if (idIndex === -1 || predIndex === -1) {
    return {
      valid: false,
      error: 'CSV must contain exactly "Sanctuary_ID" and "Survival_Probability" columns in the header.'
    };
  }

  // 2. Parse and Validate Predictions
  const predictions = new Map();
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map((c) => c.trim());
    if (row.length < 2) continue;

    const id = row[idIndex];
    const predStr = row[predIndex];
    const predVal = parseFloat(predStr);

    if (!id) {
      return { valid: false, error: `Row ${i + 1} has an empty Sanctuary_ID.` };
    }
    if (predictions.has(id)) {
      return { valid: false, error: `Duplicate Sanctuary_ID detected: ${id} at row ${i + 1}.` };
    }
    if (!groundTruthMap.has(id)) {
      return { valid: false, error: `Unrecognized Sanctuary_ID: "${id}". Must match the 120 test survivors.` };
    }
    if (isNaN(predVal) || !isFinite(predVal)) {
      return { valid: false, error: `Non-numeric or NaN Survival_Probability for ID ${id} at row ${i + 1}.` };
    }
    if (predVal < 0.0 || predVal > 1.0) {
      return { valid: false, error: `Survival_Probability for ID ${id} out of bounds (${predVal}). Must be between 0.0 and 1.0.` };
    }

    predictions.set(id, predVal);
  }

  // 3. Verify exactly 120 rows
  if (predictions.size !== groundTruthMap.size) {
    return {
      valid: false,
      error: `Expected exactly ${groundTruthMap.size} prediction records, but received ${predictions.size}.`
    };
  }

  // 4. Calculate R2 and MSE
  let ssRes = 0;
  let mseSum = 0;

  for (const [id, yTrue] of groundTruthMap.entries()) {
    const yPred = predictions.get(id);
    const diff = yTrue - yPred;
    ssRes += Math.pow(diff, 2);
    mseSum += Math.pow(diff, 2);
  }

  const r2 = 1 - (ssRes / groundTruthStats.ssTot);
  const mse = mseSum / groundTruthStats.n;
  const qualifies = r2 >= qualifyingThreshold;

  return {
    valid: true,
    r2Score: Math.round(r2 * 10000) / 10000,
    mseScore: Math.round(mse * 1000000) / 1000000,
    qualifiesForEscape: qualifies,
    threshold: qualifyingThreshold,
    message: qualifies
      ? `QUALIFIED! Model achieved R² = ${(r2 * 100).toFixed(2)}% (Target: >= ${(qualifyingThreshold * 100).toFixed(0)}%). Transit Gate unlocked!`
      : `Model evaluated: R² = ${(r2 * 100).toFixed(2)}%, MSE = ${mse.toFixed(6)}. Qualification threshold is ${(qualifyingThreshold * 100).toFixed(0)}%.`
  };
}

module.exports = {
  loadGroundTruth,
  evaluateSubmission,
  ESCAPE_THRESHOLD
};
