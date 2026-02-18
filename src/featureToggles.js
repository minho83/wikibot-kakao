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

// 데이터 구조: { global: {...}, rooms: { roomId: { name, features } } }
let data = { global: { ...DEFAULT_FEATURES }, rooms: {} };

// 로드 (기존 flat 구조 자동 마이그레이션)
try {
  if (fs.existsSync(TOGGLES_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOGGLES_PATH, 'utf-8'));
    if (saved.global) {
      // 새 구조
      data.global = { ...DEFAULT_FEATURES, ...saved.global };
      data.rooms = saved.rooms || {};
    } else {
      // 기존 flat 구조 → 마이그레이션
      data.global = { ...DEFAULT_FEATURES, ...saved };
      data.rooms = {};
    }
  }
} catch (e) {
  console.error('Failed to load feature toggles:', e.message);
}

function save() {
  try {
    fs.writeFileSync(TOGGLES_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save toggles:', e.message);
  }
}

function getAll() {
  return { global: data.global, rooms: data.rooms };
}

// 방 설정 우선, 없으면 글로벌 폴백
function isEnabled(command, roomId) {
  if (roomId && data.rooms[roomId] && data.rooms[roomId].features) {
    const roomVal = data.rooms[roomId].features[command];
    if (roomVal !== undefined) return roomVal;
  }
  return data.global[command] !== false;
}

function updateGlobal(updates) {
  for (const [cmd, enabled] of Object.entries(updates)) {
    if (cmd in data.global) {
      data.global[cmd] = !!enabled;
    }
  }
  save();
}

function updateRoom(roomId, updates) {
  if (!data.rooms[roomId]) {
    data.rooms[roomId] = { name: '', features: {} };
  }
  for (const [cmd, val] of Object.entries(updates)) {
    if (!(cmd in DEFAULT_FEATURES)) continue;
    if (val === null || val === undefined) {
      // null → 기본값으로 (삭제)
      delete data.rooms[roomId].features[cmd];
    } else {
      data.rooms[roomId].features[cmd] = !!val;
    }
  }
  save();
}

function setRoomName(roomId, name) {
  if (!data.rooms[roomId]) {
    data.rooms[roomId] = { name: '', features: {} };
  }
  data.rooms[roomId].name = name;
  save();
}

// 방 자동 등록 (이름 옵션)
function trackRoom(roomId, roomName) {
  if (!roomId) return;
  if (data.rooms[roomId]) {
    // 이름이 비어있고 새 이름이 있으면 업데이트
    if (!data.rooms[roomId].name && roomName) {
      data.rooms[roomId].name = roomName;
      save();
    }
    return;
  }
  data.rooms[roomId] = { name: roomName || '', features: {} };
  save();
}

module.exports = { getAll, isEnabled, updateGlobal, updateRoom, setRoomName, trackRoom, DEFAULT_FEATURES };
