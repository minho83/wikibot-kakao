const fs = require('fs');
const path = require('path');

const TOGGLES_PATH = path.join(__dirname, '..', 'feature-toggles.json');
const DEFAULT_FEATURES = {
  '!검색': true,
  '!통계': true,
  '!현자': true,
  '!공지': true,
  '!업데이트': true,
  '!파티': true,
};

let featureToggles = { ...DEFAULT_FEATURES };
try {
  if (fs.existsSync(TOGGLES_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOGGLES_PATH, 'utf-8'));
    featureToggles = { ...DEFAULT_FEATURES, ...saved };
  }
} catch (e) {
  console.error('Failed to load feature toggles:', e.message);
}

function save() {
  try {
    fs.writeFileSync(TOGGLES_PATH, JSON.stringify(featureToggles, null, 2));
  } catch (e) {
    console.error('Failed to save toggles:', e.message);
  }
}

function getAll() {
  return featureToggles;
}

function isEnabled(command) {
  return featureToggles[command] !== false;
}

function update(updates) {
  for (const [cmd, enabled] of Object.entries(updates)) {
    if (cmd in featureToggles) {
      featureToggles[cmd] = !!enabled;
    }
  }
  save();
}

module.exports = { getAll, isEnabled, update };
