const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class PartyService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../party.db');
    this.db = null;
    this.initialized = false;
    this.saveInterval = null;
  }

  /**
   * 한국 시간 기준 현재 날짜/시간 반환
   */
  _getKoreanDate() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const SQL = await initSqlJs();

      if (fs.existsSync(this.dbPath)) {
        const buffer = fs.readFileSync(this.dbPath);
        if (buffer.length > 0) {
          try {
            this.db = new SQL.Database(buffer);
          } catch (e) {
            console.warn('party.db corrupt, creating fresh DB:', e.message);
            this.db = new SQL.Database();
          }
        } else {
          console.warn('party.db is empty (0 bytes), creating fresh DB');
          this.db = new SQL.Database();
        }
      } else {
        this.db = new SQL.Database();
      }

      this._createTables();
      this.initialized = true;

      this.saveInterval = setInterval(() => this.saveDb(), 5 * 60 * 1000);
      console.log('PartyService initialized');
    } catch (error) {
      console.error('Failed to initialize PartyService:', error);
      throw error;
    }
  }

  _createTables() {
    // 파티 모집글 테이블
    this.db.run(`
      CREATE TABLE IF NOT EXISTS party_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_date TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        location TEXT,
        party_name TEXT,
        warrior_slots TEXT,
        rogue_slots TEXT,
        mage_slots TEXT,
        cleric_slots TEXT,
        taoist_slots TEXT,
        requirements TEXT,
        is_complete INTEGER DEFAULT 0,
        raw_message TEXT,
        sender_name TEXT,
        room_id TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    // 파티방 설정 테이블
    this.db.run(`
      CREATE TABLE IF NOT EXISTS party_rooms (
        room_id TEXT PRIMARY KEY,
        room_name TEXT,
        collect INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_party_date ON party_posts(party_date, time_slot)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_party_room ON party_posts(room_id, party_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_party_unique ON party_posts(party_date, time_slot, sender_name, room_id)`);
  }

  saveDb() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (e) {
      console.error('Failed to save party.db:', e);
    }
  }

  close() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveDb();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  // ── 파티방 관리 ──────────────────────────────────────

  getPartyRoom(roomId) {
    if (!this.db) return null;
    const result = this.db.exec(
      `SELECT room_id, room_name, collect, enabled FROM party_rooms WHERE room_id = ? AND enabled = 1`,
      [roomId]
    );
    if (result.length > 0 && result[0].values.length > 0) {
      const row = result[0].values[0];
      return { room_id: row[0], room_name: row[1], collect: !!row[2], enabled: !!row[3] };
    }
    return null;
  }

  addPartyRoom(roomId, roomName, collect = false) {
    if (!this.db) return false;
    try {
      this.db.run(
        `INSERT OR REPLACE INTO party_rooms (room_id, room_name, collect, enabled, created_at)
         VALUES (?, ?, ?, 1, datetime('now','localtime'))`,
        [roomId, roomName || '', collect ? 1 : 0]
      );
      this.saveDb();
      return true;
    } catch (e) {
      console.error('addPartyRoom error:', e);
      return false;
    }
  }

  removePartyRoom(roomId) {
    if (!this.db) return false;
    try {
      this.db.run(`DELETE FROM party_rooms WHERE room_id = ?`, [roomId]);
      this.saveDb();
      return true;
    } catch (e) {
      console.error('removePartyRoom error:', e);
      return false;
    }
  }

  listPartyRooms() {
    if (!this.db) return [];
    const result = this.db.exec(
      `SELECT room_id, room_name, collect, enabled FROM party_rooms WHERE enabled = 1`
    );
    if (result.length > 0) {
      return result[0].values.map(row => ({
        room_id: row[0],
        room_name: row[1],
        collect: !!row[2],
        enabled: !!row[3]
      }));
    }
    return [];
  }

  // ── 날짜 파싱 ──────────────────────────────────────

  /**
   * 다양한 날짜 형식을 YYYY-MM-DD로 변환
   * @param {string} text - "12/28[일]", "12.27토요일", "◆12월27일 토", "오늘", "내일", "2/6"
   * @param {Date} baseDate - 기준 날짜 (기본: 오늘)
   * @returns {string|null} - "2026-02-06" 형식
   */
  parseDate(text, baseDate = new Date()) {
    if (!text) return null;

    const today = new Date(baseDate);
    today.setHours(0, 0, 0, 0);

    // "오늘", "내일"
    if (/오늘/.test(text)) {
      return this._formatDate(today);
    }
    if (/내일/.test(text)) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return this._formatDate(tomorrow);
    }

    // "12/28[일]", "12/28(일)", "12/28 일"
    let match = text.match(/(\d{1,2})[\/\.](\d{1,2})\s*[\[(]?[일월화수목금토]?[\])]?/);
    if (match) {
      return this._resolveDate(parseInt(match[1]), parseInt(match[2]), today);
    }

    // "12월27일 토", "12월 27일"
    match = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
    if (match) {
      return this._resolveDate(parseInt(match[1]), parseInt(match[2]), today);
    }

    // "2/6" 단순 형식
    match = text.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (match) {
      return this._resolveDate(parseInt(match[1]), parseInt(match[2]), today);
    }

    return null;
  }

  _formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  _resolveDate(month, day, baseDate) {
    // 연도 추정: 현재 연도 또는 다음 연도
    let year = baseDate.getFullYear();
    const candidate = new Date(year, month - 1, day);

    // 3개월 이상 과거면 다음 연도로
    const monthDiff = (baseDate.getMonth() + 1) - month;
    if (monthDiff > 3) {
      year++;
    }

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // ── 시간 파싱 ──────────────────────────────────────

  /**
   * 다양한 시간 형식을 HH:MM~HH:MM으로 변환
   * @param {string} text - "13:00~15:00", "★19시 ~ 21시", "1800- 2000"
   * @returns {string|null}
   */
  parseTimeSlot(text) {
    if (!text) return null;

    // "13:00~15:00", "13:00 ~ 15:00"
    let match = text.match(/(\d{1,2}):(\d{2})\s*[~\-]\s*(\d{1,2}):(\d{2})/);
    if (match) {
      const start = `${match[1].padStart(2, '0')}:${match[2]}`;
      const end = `${match[3].padStart(2, '0')}:${match[4]}`;
      return `${start}~${end}`;
    }

    // "19시 ~ 21시", "19시~21시"
    match = text.match(/(\d{1,2})시\s*[~\-]\s*(\d{1,2})시/);
    if (match) {
      const start = `${match[1].padStart(2, '0')}:00`;
      const end = `${match[2].padStart(2, '0')}:00`;
      return `${start}~${end}`;
    }

    // "1800- 2000", "1800~2000"
    match = text.match(/(\d{2})(\d{2})\s*[~\-]\s*(\d{2})(\d{2})/);
    if (match) {
      const start = `${match[1]}:${match[2]}`;
      const end = `${match[3]}:${match[4]}`;
      return `${start}~${end}`;
    }

    // "23:10~00:40"도 처리
    match = text.match(/(\d{1,2}):(\d{2})\s*[~\-]\s*(\d{1,2}):(\d{2})/);
    if (match) {
      const start = `${match[1].padStart(2, '0')}:${match[2]}`;
      const end = `${match[3].padStart(2, '0')}:${match[4]}`;
      return `${start}~${end}`;
    }

    return null;
  }

  // ── 슬롯 파싱 ──────────────────────────────────────

  /**
   * 직업별 슬롯 파싱
   * @param {string} line - "전사 [랭퀵] []" 또는 "도적[베라뮤진][]"
   * @returns {object} - { job: 'warrior', slots: ['랭퀵', ''], isEmpty: [false, true] }
   */
  parseJobSlots(line) {
    if (!line) return null;

    const jobMap = {
      '전사': 'warrior', '데빌': 'warrior',
      '도적': 'rogue',
      '법사': 'mage', '딜법': 'mage', '아나테마': 'mage', '인식': 'mage', '세손': 'mage', '세손법': 'mage',
      '직자': 'cleric',
      '도가': 'taoist', '무도가': 'taoist'
    };

    // 직업명 찾기
    let foundJob = null;
    let jobKey = null;
    for (const [name, key] of Object.entries(jobMap)) {
      if (line.includes(name)) {
        foundJob = name;
        jobKey = key;
        break;
      }
    }

    if (!foundJob) return null;

    // 슬롯 추출: [닉네임] 또는 []
    const slots = [];
    const slotRegex = /\[([^\]]*)\]/g;
    let match;
    while ((match = slotRegex.exec(line)) !== null) {
      const content = match[1].trim();
      slots.push(content);
    }

    if (slots.length === 0) return null;

    return {
      job: jobKey,
      jobName: foundJob,
      slots: slots,
      emptyCount: slots.filter(s => s === '').length
    };
  }

  // ── 메시지 파싱 ──────────────────────────────────────

  /**
   * 파티 모집 메시지 파싱
   * @param {string} rawMessage - 전체 메시지
   * @param {object} senderInfo - { name, room_id }
   * @returns {Array} - 파싱된 파티 목록 (하나의 메시지에 여러 타임슬롯 가능)
   */
  parseMessage(rawMessage, senderInfo = {}) {
    if (!rawMessage) return [];

    const lines = rawMessage.split('\n').map(l => l.trim()).filter(l => l);
    const parties = [];

    // 메시지 전체에서 날짜 찾기
    let partyDate = null;
    let location = null;
    let partyName = null;
    let requirements = {};
    let isComplete = false;

    // 완비 체크
    if (/#완비/.test(rawMessage)) {
      isComplete = true;
    }

    // 첫 몇 줄에서 날짜, 장소, 팟 이름 파싱
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i];

      // 날짜 파싱
      if (!partyDate) {
        const parsed = this.parseDate(line, this._getKoreanDate());
        if (parsed) {
          partyDate = parsed;
        }
      }

      // 장소 파싱 (원본 그대로 표시)
      // 나겔목/나겔반은 장비(목걸이/반지)이므로 제외
      if (!location) {
        const locMatch = line.match(/[#<>★]*(탑층|상층|고층|설원|필드|나겔탑[^\s]*|나겔링|나겔\s*\d층)/);
        if (locMatch) {
          location = locMatch[1];
        }
      }

      // 팟 이름 파싱 (낭만사냥팟, 물고기파티 등)
      if (!partyName) {
        const nameMatch = line.match(/([가-힣]+팟|[가-힣]+파티)/);
        if (nameMatch) {
          partyName = nameMatch[1];
        }
      }

      // 요구사항 파싱 (#데빌체580↑8강↑)
      const reqMatch = line.match(/#(데빌|도적|도가|직자|법사)\s*[:：]?\s*([^\n#]+)/);
      if (reqMatch) {
        requirements[reqMatch[1]] = reqMatch[2].trim();
      }
    }

    // 타임슬롯별로 파티 파싱
    let currentTimeSlot = null;
    let currentSlots = {
      warrior: [], rogue: [], mage: [], cleric: [], taoist: []
    };

    for (const line of lines) {
      // 시간대 감지
      const timeSlot = this.parseTimeSlot(line);
      if (timeSlot) {
        // 이전 타임슬롯 저장
        if (currentTimeSlot && this._hasAnySlots(currentSlots)) {
          parties.push({
            party_date: partyDate,
            time_slot: currentTimeSlot,
            location,
            party_name: partyName,
            warrior_slots: JSON.stringify(currentSlots.warrior),
            rogue_slots: JSON.stringify(currentSlots.rogue),
            mage_slots: JSON.stringify(currentSlots.mage),
            cleric_slots: JSON.stringify(currentSlots.cleric),
            taoist_slots: JSON.stringify(currentSlots.taoist),
            requirements: JSON.stringify(requirements),
            is_complete: isComplete ? 1 : 0,
            raw_message: rawMessage,
            sender_name: senderInfo.name || '',
            room_id: senderInfo.room_id || ''
          });
        }

        // 새 타임슬롯 시작
        currentTimeSlot = timeSlot;
        currentSlots = { warrior: [], rogue: [], mage: [], cleric: [], taoist: [] };
        continue;
      }

      // 직업 슬롯 파싱
      if (currentTimeSlot) {
        const parsed = this.parseJobSlots(line);
        if (parsed && currentSlots[parsed.job]) {
          currentSlots[parsed.job] = parsed.slots;
        }
      }
    }

    // 마지막 타임슬롯 저장
    if (currentTimeSlot && this._hasAnySlots(currentSlots)) {
      parties.push({
        party_date: partyDate,
        time_slot: currentTimeSlot,
        location,
        party_name: partyName,
        warrior_slots: JSON.stringify(currentSlots.warrior),
        rogue_slots: JSON.stringify(currentSlots.rogue),
        mage_slots: JSON.stringify(currentSlots.mage),
        cleric_slots: JSON.stringify(currentSlots.cleric),
        taoist_slots: JSON.stringify(currentSlots.taoist),
        requirements: JSON.stringify(requirements),
        is_complete: isComplete ? 1 : 0,
        raw_message: rawMessage,
        sender_name: senderInfo.name || '',
        room_id: senderInfo.room_id || ''
      });
    }

    return parties;
  }

  _hasAnySlots(slots) {
    return Object.values(slots).some(arr => arr.length > 0);
  }

  // ── 메시지 수집 ──────────────────────────────────────

  /**
   * 파티 메시지 수집 및 저장
   */
  collectMessage(message, senderInfo, roomId) {
    if (!this.db) return [];

    // 파티 모집 메시지인지 간단 체크
    if (!this._isPartyMessage(message)) {
      return [];
    }

    const parties = this.parseMessage(message, { ...senderInfo, room_id: roomId });

    for (const party of parties) {
      if (!party.party_date || !party.time_slot) continue;

      // 같은 날짜/시간대/주최자/방의 기존 파티가 있으면 업데이트, 없으면 삽입
      // (같은 주최자가 올린 파티만 최신으로 갱신, 다른 주최자 파티는 별도 저장)
      const existing = this.db.exec(
        `SELECT id FROM party_posts
         WHERE party_date = ? AND time_slot = ? AND sender_name = ? AND room_id = ?
         ORDER BY updated_at DESC LIMIT 1`,
        [party.party_date, party.time_slot, party.sender_name, party.room_id]
      );

      if (existing.length > 0 && existing[0].values.length > 0) {
        const id = existing[0].values[0][0];
        this.db.run(
          `UPDATE party_posts SET
           location = ?, party_name = ?,
           warrior_slots = ?, rogue_slots = ?, mage_slots = ?,
           cleric_slots = ?, taoist_slots = ?, requirements = ?,
           is_complete = ?, raw_message = ?, sender_name = ?,
           updated_at = datetime('now','localtime')
           WHERE id = ?`,
          [
            party.location, party.party_name,
            party.warrior_slots, party.rogue_slots, party.mage_slots,
            party.cleric_slots, party.taoist_slots, party.requirements,
            party.is_complete, party.raw_message, party.sender_name,
            id
          ]
        );
      } else {
        this.db.run(
          `INSERT INTO party_posts
           (party_date, time_slot, location, party_name,
            warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots,
            requirements, is_complete, raw_message, sender_name, room_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            party.party_date, party.time_slot, party.location, party.party_name,
            party.warrior_slots, party.rogue_slots, party.mage_slots,
            party.cleric_slots, party.taoist_slots,
            party.requirements, party.is_complete, party.raw_message,
            party.sender_name, party.room_id
          ]
        );
      }
    }

    if (parties.length > 0) {
      this.saveDb();
    }

    return parties;
  }

  _isPartyMessage(message) {
    // 파티 모집 메시지 특징 체크
    const indicators = [
      /\d{1,2}[\/\.월]\d{1,2}/,  // 날짜 패턴
      /\d{1,2}[:시]\d{0,2}\s*[~\-]/,  // 시간 패턴
      /\[[^\]]*\]/,  // 슬롯 패턴
      /전사|도적|법사|직자|도가|데빌/,  // 직업명
      /#나겔|겜블|사냥팟|파티/  // 장소/이름
    ];

    let matchCount = 0;
    for (const pattern of indicators) {
      if (pattern.test(message)) {
        matchCount++;
      }
    }

    return matchCount >= 3;
  }

  // ── 파티 조회 ──────────────────────────────────────

  /**
   * 파티 조회
   * @param {object} options - { date, job, includeComplete, afterTime }
   * @returns {object} - { answer, parties }
   */
  queryParties(options = {}) {
    if (!this.db) return { answer: '서비스가 초기화되지 않았습니다.', parties: [] };

    const {
      date,
      job,
      includeComplete = false,
      afterTime = null
    } = options;

    // 날짜 파싱
    let targetDate = date;
    const koreanNow = this._getKoreanDate();
    if (!targetDate || targetDate === '오늘') {
      targetDate = this._formatDate(koreanNow);
    } else if (targetDate === '내일') {
      const tomorrow = new Date(koreanNow);
      tomorrow.setDate(tomorrow.getDate() + 1);
      targetDate = this._formatDate(tomorrow);
    } else {
      // "2/6" 같은 형식 파싱
      const parsed = this.parseDate(targetDate, koreanNow);
      if (parsed) {
        targetDate = parsed;
      }
    }

    // 쿼리 빌드
    let sql = `
      SELECT id, party_date, time_slot, location, party_name,
             warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots,
             requirements, is_complete, sender_name, updated_at
      FROM party_posts
      WHERE party_date = ?
    `;
    const params = [targetDate];

    if (!includeComplete) {
      sql += ` AND is_complete = 0`;
    }

    // 현재 시간 이후만 (오늘인 경우)
    const todayStr = this._formatDate(koreanNow);
    if (targetDate === todayStr) {
      const currentTime = `${String(koreanNow.getHours()).padStart(2, '0')}:${String(koreanNow.getMinutes()).padStart(2, '0')}`;
      sql += ` AND substr(time_slot, 1, 5) >= ?`;
      params.push(currentTime);
    }

    sql += ` ORDER BY time_slot ASC`;

    const result = this.db.exec(sql, params);
    if (result.length === 0 || result[0].values.length === 0) {
      return {
        answer: `${this._formatDisplayDate(targetDate)} 빈자리 있는 파티가 없습니다.`,
        parties: []
      };
    }

    const parties = result[0].values.map(row => ({
      id: row[0],
      party_date: row[1],
      time_slot: row[2],
      location: row[3],
      party_name: row[4],
      warrior_slots: this._safeJsonParse(row[5]),
      rogue_slots: this._safeJsonParse(row[6]),
      mage_slots: this._safeJsonParse(row[7]),
      cleric_slots: this._safeJsonParse(row[8]),
      taoist_slots: this._safeJsonParse(row[9]),
      requirements: this._safeJsonParse(row[10]),
      is_complete: row[11],
      sender_name: row[12],
      updated_at: row[13]
    }));

    // 빈자리 있는 파티만 필터
    const partiesWithSlots = parties.filter(p => {
      const emptySlots = this._countEmptySlots(p, job);
      return emptySlots.total > 0;
    });

    if (partiesWithSlots.length === 0) {
      const jobName = job ? this._getJobDisplayName(job) : '';
      return {
        answer: `${this._formatDisplayDate(targetDate)} ${jobName} 빈자리 있는 파티가 없습니다.`,
        parties: []
      };
    }

    // 응답 포맷
    const answer = this._formatPartyList(targetDate, partiesWithSlots, job);

    return { answer, parties: partiesWithSlots };
  }

  _safeJsonParse(str) {
    if (!str) return [];
    try {
      return JSON.parse(str);
    } catch {
      return [];
    }
  }

  _countEmptySlots(party, filterJob = null) {
    const result = { total: 0 };
    const jobs = ['warrior', 'rogue', 'mage', 'cleric', 'taoist'];
    const jobNames = ['전사', '도적', '법사', '직자', '도가'];

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const slots = party[`${job}_slots`] || [];
      const empty = slots.filter(s => s === '').length;
      result[job] = empty;

      // 특정 직업 필터
      if (filterJob) {
        if (this._matchJob(filterJob, job) && empty > 0) {
          result.total += empty;
        }
      } else {
        result.total += empty;
      }
    }

    return result;
  }

  _matchJob(input, jobKey) {
    const aliases = {
      warrior: ['전사', '데빌'],
      rogue: ['도적'],
      mage: ['법사', '딜법'],
      cleric: ['직자'],
      taoist: ['도가', '도가자리']
    };

    const inputLower = input.toLowerCase();
    if (inputLower === jobKey) return true;

    return (aliases[jobKey] || []).some(alias =>
      input.includes(alias)
    );
  }

  _getJobDisplayName(input) {
    const map = {
      '전사': '전사', 'warrior': '전사', '데빌': '전사',
      '도적': '도적', 'rogue': '도적',
      '법사': '법사', 'mage': '법사',
      '직자': '직자', 'cleric': '직자',
      '도가': '도가', 'taoist': '도가'
    };
    return map[input] || input;
  }

  _formatDisplayDate(dateStr) {
    // "2026-02-06" → "2/6(목)"
    const date = new Date(dateStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayName = dayNames[date.getDay()];
    return `${month}/${day}(${dayName})`;
  }

  _formatPartyList(targetDate, parties, filterJob = null) {
    const lines = [`📋 ${this._formatDisplayDate(targetDate)} 빈자리 파티`];
    if (filterJob) {
      lines[0] += ` (${this._getJobDisplayName(filterJob)})`;
    }
    lines.push('');

    for (const party of parties) {
      // 파티 헤더: [장소] 시간 @주최자
      const locationName = party.location || '미정';
      const senderName = party.sender_name ? `@${party.sender_name.split('/')[0]}` : '';
      lines.push(`[${locationName}] ${party.time_slot} ${senderName}`.trim());

      // 빈자리 정보
      const emptyInfo = [];
      const jobDisplayNames = {
        warrior: '전사', rogue: '도적', mage: '법사', cleric: '직자', taoist: '도가'
      };

      for (const [job, name] of Object.entries(jobDisplayNames)) {
        const slots = party[`${job}_slots`] || [];
        const empty = slots.filter(s => s === '').length;

        // 필터가 있으면 해당 직업만, 없으면 빈자리 있는 것만
        if (filterJob) {
          if (this._matchJob(filterJob, job) && empty > 0) {
            emptyInfo.push(`${name} ${empty}자리`);
          }
        } else if (empty > 0) {
          emptyInfo.push(`${name} ${empty}자리`);
        }
      }

      if (emptyInfo.length > 0) {
        lines.push(` ${emptyInfo.join(' │ ')}`);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  // ── 통계 ──────────────────────────────────────

  getStats() {
    if (!this.db) return { success: false };

    try {
      const today = this._formatDate(this._getKoreanDate());
      const result = {};

      // 오늘 파티 수
      const todayResult = this.db.exec(
        `SELECT COUNT(*) FROM party_posts WHERE party_date = ?`,
        [today]
      );
      result.today_parties = todayResult[0]?.values[0]?.[0] || 0;

      // 전체 파티 수
      const totalResult = this.db.exec(`SELECT COUNT(*) FROM party_posts`);
      result.total_parties = totalResult[0]?.values[0]?.[0] || 0;

      // 수집방 수
      const roomResult = this.db.exec(
        `SELECT COUNT(*) FROM party_rooms WHERE collect = 1 AND enabled = 1`
      );
      result.collect_rooms = roomResult[0]?.values[0]?.[0] || 0;

      return { success: true, ...result };
    } catch (e) {
      console.error('getStats error:', e);
      return { success: false, message: e.message };
    }
  }

  // ── 오래된 데이터 정리 ──────────────────────────────────────

  cleanupOldParties(daysToKeep = 7) {
    if (!this.db) return { success: false };

    try {
      const cutoffDate = this._getKoreanDate();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      const cutoff = this._formatDate(cutoffDate);

      const before = this.db.exec(`SELECT COUNT(*) FROM party_posts`);
      const beforeCount = before[0]?.values[0]?.[0] || 0;

      this.db.run(`DELETE FROM party_posts WHERE party_date < ?`, [cutoff]);

      const after = this.db.exec(`SELECT COUNT(*) FROM party_posts`);
      const afterCount = after[0]?.values[0]?.[0] || 0;

      this.saveDb();

      return {
        success: true,
        removed: beforeCount - afterCount,
        kept: afterCount
      };
    } catch (e) {
      console.error('cleanupOldParties error:', e);
      return { success: false, message: e.message };
    }
  }
}

module.exports = { PartyService };
