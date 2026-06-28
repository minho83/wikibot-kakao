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

  /**
   * 한국 시간 기준 현재 시각을 SQLite datetime 형식으로 반환
   * @returns {string} 'YYYY-MM-DD HH:MM:SS'
   */
  _getKoreanDatetime() {
    const d = this._getKoreanDate();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
        created_at TEXT,
        updated_at TEXT
      )
    `);

    // 파티방 설정 테이블
    this.db.run(`
      CREATE TABLE IF NOT EXISTS party_rooms (
        room_id TEXT PRIMARY KEY,
        room_name TEXT,
        collect INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT
      )
    `);

    // 봇이 관측한 방 테이블 (미등록 방 자동발견용)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS seen_rooms (
        room_id TEXT PRIMARY KEY,
        sample_message TEXT,
        sender_name TEXT,
        seen_count INTEGER DEFAULT 0,
        first_seen TEXT,
        last_seen TEXT
      )
    `);

    // organizer 컬럼 마이그레이션 (기존 DB 호환)
    try {
      this.db.run(`ALTER TABLE party_posts ADD COLUMN organizer TEXT`);
    } catch (e) {
      // 이미 존재하면 무시
    }

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_party_date ON party_posts(party_date, time_slot)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_party_room ON party_posts(room_id, party_date)`);
    // 기존 sender_name 기반 인덱스 → organizer 기반으로 변경
    this.db.run(`DROP INDEX IF EXISTS idx_party_unique`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_party_organizer ON party_posts(party_date, time_slot, organizer, room_id)`);

    // UTC→KST 보정 마이그레이션 (1회성)
    this.db.run(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
    const done = this.db.exec(`SELECT 1 FROM _migrations WHERE name = 'utc_to_kst'`);
    if (!done.length || !done[0].values.length) {
      console.log('[PartyService] UTC→KST 마이그레이션: 기존 시간에 +9시간 보정');
      this.db.run(`UPDATE party_posts SET created_at = datetime(created_at, '+9 hours') WHERE created_at IS NOT NULL`);
      this.db.run(`UPDATE party_posts SET updated_at = datetime(updated_at, '+9 hours') WHERE updated_at IS NOT NULL`);
      this.db.run(`UPDATE party_rooms SET created_at = datetime(created_at, '+9 hours') WHERE created_at IS NOT NULL`);
      this.db.run(`INSERT INTO _migrations (name) VALUES ('utc_to_kst')`);
      this.saveDb();
      console.log('[PartyService] UTC→KST 마이그레이션 완료');
    }

    // 깨진 날짜 보정 마이그레이션 (YY.MM.DD 파싱 버그로 month>12인 행 재파싱)
    const fixDone = this.db.exec(`SELECT 1 FROM _migrations WHERE name = 'fix_bad_dates'`);
    if (!fixDone.length || !fixDone[0].values.length) {
      this._fixMalformedDates();
      this.db.run(`INSERT INTO _migrations (name) VALUES ('fix_bad_dates')`);
      this.saveDb();
    }
  }

  /**
   * party_date의 월(月)이 12 초과인 깨진 행을 raw_message 재파싱으로 보정
   * (구버전 파서가 "26.06.28"을 26/06으로 오인해 "2026-26-06"으로 저장한 버그 복구)
   */
  _fixMalformedDates() {
    try {
      const res = this.db.exec(
        `SELECT id, time_slot, raw_message FROM party_posts
         WHERE CAST(substr(party_date, 6, 2) AS INTEGER) > 12`
      );
      if (!res.length || !res[0].values.length) return;

      let fixed = 0;
      for (const row of res[0].values) {
        const [id, timeSlot, rawMessage] = row;
        if (!rawMessage) continue;
        // 같은 메시지를 새 파서로 재파싱 후 time_slot이 일치하는 파티의 날짜 사용
        const reparsed = this.parseMessage(rawMessage, {});
        const match = reparsed.find(p => p.time_slot === timeSlot && p.party_date);
        if (match) {
          this.db.run(`UPDATE party_posts SET party_date = ? WHERE id = ?`, [match.party_date, id]);
          fixed++;
        }
      }
      if (fixed > 0) {
        console.log(`[PartyService] 깨진 날짜 보정 완료: ${fixed}건`);
      }
    } catch (e) {
      console.error('[PartyService] _fixMalformedDates error:', e);
    }
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
         VALUES (?, ?, ?, 1, ?)`,
        [roomId, roomName || '', collect ? 1 : 0, this._getKoreanDatetime()]
      );
      this.forgetSeenRoom(roomId);
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

  // ── 미등록 방 자동발견 / 수집 상태 ──────────────────────

  /**
   * 봇이 메시지를 본 방을 기록 (미등록 방 발견용)
   * room-check 시 호출. 등록된 방은 호출 측에서 걸러서 미등록만 넘긴다.
   */
  recordSeenRoom(roomId, sampleMessage = '', senderName = '') {
    if (!this.db || !roomId) return;
    try {
      const now = this._getKoreanDatetime();
      const sample = (sampleMessage || '').slice(0, 200);
      const existing = this.db.exec(
        `SELECT seen_count FROM seen_rooms WHERE room_id = ?`, [roomId]
      );
      if (existing.length > 0 && existing[0].values.length > 0) {
        this.db.run(
          `UPDATE seen_rooms
           SET sample_message = ?, sender_name = ?, seen_count = seen_count + 1, last_seen = ?
           WHERE room_id = ?`,
          [sample, senderName || '', now, roomId]
        );
      } else {
        this.db.run(
          `INSERT INTO seen_rooms (room_id, sample_message, sender_name, seen_count, first_seen, last_seen)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [roomId, sample, senderName || '', now, now]
        );
      }
    } catch (e) {
      console.error('recordSeenRoom error:', e);
    }
  }

  /**
   * 등록되지 않은(party_rooms에 없는) 관측 방 목록 — 최근 활동 순
   */
  listUnregisteredRooms() {
    if (!this.db) return [];
    const result = this.db.exec(
      `SELECT room_id, sample_message, sender_name, seen_count, first_seen, last_seen
       FROM seen_rooms
       WHERE room_id NOT IN (SELECT room_id FROM party_rooms)
       ORDER BY last_seen DESC`
    );
    if (result.length > 0) {
      return result[0].values.map(row => ({
        room_id: row[0],
        sample_message: row[1] || '',
        sender_name: row[2] || '',
        seen_count: row[3] || 0,
        first_seen: row[4],
        last_seen: row[5]
      }));
    }
    return [];
  }

  /**
   * 등록된 방을 seen_rooms에서 제거 (등록 직후 발견목록 정리)
   */
  forgetSeenRoom(roomId) {
    if (!this.db || !roomId) return;
    try {
      this.db.run(`DELETE FROM seen_rooms WHERE room_id = ?`, [roomId]);
    } catch (e) {
      console.error('forgetSeenRoom error:', e);
    }
  }

  /**
   * 등록된 방별 수집 상태 — 누적 건수, 오늘 건수, 마지막 수집 시각
   */
  getRoomCollectionStats() {
    if (!this.db) return [];
    const rooms = this.listPartyRooms();
    const today = this._formatDate(this._getKoreanDate());
    return rooms.map(room => {
      let postCount = 0, todayCount = 0, lastCollected = null;
      try {
        const agg = this.db.exec(
          `SELECT COUNT(*), MAX(updated_at) FROM party_posts WHERE room_id = ?`,
          [room.room_id]
        );
        if (agg.length > 0 && agg[0].values.length > 0) {
          postCount = agg[0].values[0][0] || 0;
          lastCollected = agg[0].values[0][1] || null;
        }
        const todayAgg = this.db.exec(
          `SELECT COUNT(*) FROM party_posts WHERE room_id = ? AND party_date = ?`,
          [room.room_id, today]
        );
        if (todayAgg.length > 0 && todayAgg[0].values.length > 0) {
          todayCount = todayAgg[0].values[0][0] || 0;
        }
      } catch (e) {
        console.error('getRoomCollectionStats error:', e);
      }
      return {
        room_id: room.room_id,
        room_name: room.room_name,
        collect: room.collect,
        post_count: postCount,
        today_count: todayCount,
        last_collected: lastCollected
      };
    });
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

    // "26.06.28", "26.06.28(일)", "26/06/28" — YY.MM.DD 3자리 형식 (연도 명시)
    // 2자리 형식보다 먼저 검사해야 함 (26.06.28을 26/06으로 오인 방지)
    let match = text.match(/(\d{2})[\/\.](\d{1,2})[\/\.](\d{1,2})/);
    if (match) {
      const explicitYear = 2000 + parseInt(match[1]);
      return this._resolveDate(parseInt(match[2]), parseInt(match[3]), today, explicitYear);
    }

    // "12/28[일]", "12/28(일)", "12/28 일"
    match = text.match(/(\d{1,2})[\/\.](\d{1,2})\s*[\[(]?[일월화수목금토]?[\])]?/);
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

  _resolveDate(month, day, baseDate, explicitYear = null) {
    // 연도가 명시된 경우(YY.MM.DD) 추정 없이 그대로 사용
    let year = explicitYear !== null ? explicitYear : baseDate.getFullYear();

    if (explicitYear === null) {
      // 3개월 이상 과거면 다음 연도로
      const monthDiff = (baseDate.getMonth() + 1) - month;
      if (monthDiff > 3) {
        year++;
      }
    }

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // ── 주최자 파싱 ──────────────────────────────────────

  /**
   * 메시지 마지막 부분에서 @주최자 파싱
   * @param {string} rawMessage - 전체 메시지
   * @returns {string|null} - 주최자 닉네임 (서버명 제외)
   */
  parseOrganizer(rawMessage) {
    if (!rawMessage) return null;

    // 마지막 5줄에서 @이름 또는 @이름/서버 패턴 탐색
    const lines = rawMessage.split('\n').map(l => l.trim()).filter(l => l);
    const lastLines = lines.slice(-5);

    for (let i = lastLines.length - 1; i >= 0; i--) {
      const match = lastLines[i].match(/^@([^\s/]+)/);
      if (match) {
        return match[1];
      }
    }

    return null;
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
      '법사': 'mage', '딜법': 'mage', '아나테마': 'mage', '인식': 'mage', '세손': 'mage', '세손법': 'mage', '저주': 'mage',
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

    // 주최자 파싱
    const organizer = this.parseOrganizer(rawMessage);

    // 메시지 전체에서 날짜 찾기
    let partyDate = null;
    let location = null;
    let partyName = null;
    let requirements = {};

    // #완비는 타임슬롯별로 개별 추적 (1부 #완비가 2부에 영향 주지 않도록)
    let pendingComplete = false;

    // 헤더 영역 파싱: 날짜 줄 ~ 첫 타임슬롯 줄 이전
    let dateLineIdx = -1;
    let firstTimeSlotIdx = -1;
    const headerNotes = [];

    // 1단계: 날짜 줄과 첫 타임슬롯 줄 위치 찾기
    for (let i = 0; i < lines.length; i++) {
      if (dateLineIdx < 0) {
        const parsed = this.parseDate(lines[i], this._getKoreanDate());
        if (parsed) {
          partyDate = parsed;
          dateLineIdx = i;
        }
      }
      if (firstTimeSlotIdx < 0 && this.parseTimeSlot(lines[i])) {
        firstTimeSlotIdx = i;
        break;
      }
    }

    // 2단계: 헤더 영역(날짜 줄 포함 ~ 첫 타임슬롯 줄 이전)에서 메타데이터 추출
    const headerEnd = firstTimeSlotIdx > 0 ? firstTimeSlotIdx : Math.min(lines.length, 10);
    for (let i = 0; i < headerEnd; i++) {
      const line = lines[i];

      // 장소 파싱 - includes 방식으로 키워드 매칭
      // 나겔목/나겔반은 장비(목걸이/반지)이므로 제외
      if (!location) {
        const LOC_KEYWORDS = ['나겔탑', '나겔링', '낡', '탑층', '상층', '고층', '설원', '필드'];
        const LOC_EXCLUDE = ['나겔목', '나겔반'];
        const hasExclude = LOC_EXCLUDE.some(ex => line.includes(ex));
        if (!hasExclude) {
          for (const kw of LOC_KEYWORDS) {
            if (line.includes(kw)) {
              location = kw;
              break;
            }
          }
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
      const reqMatch = line.match(/#(데빌|전사|도적|도가|직자|법사|딜법|아나테마|인식|세손|세손법|저주|무도가)\s*[:：]?\s*([^\n#]+)/);
      if (reqMatch) {
        requirements[reqMatch[1]] = reqMatch[2].trim();
      }

      // 자유형 조건 텍스트 수집 (날짜 줄 다음부터, 첫 타임슬롯 이전)
      if (i > dateLineIdx && dateLineIdx >= 0) {
        // 날짜 줄, 주최자(@) 줄, #직업 태그 줄, 빈 줄 제외
        if (line && !line.startsWith('@') && !reqMatch && !this.parseTimeSlot(line)) {
          headerNotes.push(line);
        }
      }
    }

    // _notes를 requirements에 추가
    if (headerNotes.length > 0) {
      requirements['_notes'] = headerNotes;
    }

    // 타임슬롯별로 파티 파싱
    let currentTimeSlot = null;
    let currentIsComplete = false;
    let currentSlots = {
      warrior: [], rogue: [], mage: [], cleric: [], taoist: []
    };
    // 다중 날짜 모집글 지원: 중간에 새 날짜 줄이 나오면 다음 섹션부터 적용
    let pendingDate = null;

    for (const line of lines) {
      // #완비를 타임슬롯 감지 전에 체크 (같은 줄에 있을 수 있으므로)
      if (/#완비/.test(line)) {
        pendingComplete = true;
      }

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
            is_complete: currentIsComplete ? 1 : 0,
            raw_message: rawMessage,
            organizer: organizer || senderInfo.name || '',
            sender_name: senderInfo.name || '',
            room_id: senderInfo.room_id || ''
          });
        }

        // 섹션 전환 시 날짜 갱신: 대기 중 날짜 → 이 줄에 함께 있는 날짜 순
        // (이전 섹션은 위에서 '이전 날짜'로 이미 저장됨)
        if (pendingDate) { partyDate = pendingDate; pendingDate = null; }
        const inlineDate = this.parseDate(line, this._getKoreanDate());
        if (inlineDate) partyDate = inlineDate;

        // 새 타임슬롯 시작: pending #완비를 이 섹션에 적용 후 리셋
        currentIsComplete = pendingComplete;
        pendingComplete = false;
        currentTimeSlot = timeSlot;
        currentSlots = { warrior: [], rogue: [], mage: [], cleric: [], taoist: [] };
        continue;
      }

      // 타임슬롯이 아닌 '날짜만 있는 줄' 감지 → 다음 섹션 날짜로 대기
      // (슬롯 [...] · #요구사항 줄은 제외해 오탐 방지)
      if (!line.startsWith('#') && !line.includes('[')) {
        const standaloneDate = this.parseDate(line, this._getKoreanDate());
        if (standaloneDate) pendingDate = standaloneDate;
      }

      // 직업 슬롯 파싱 (같은 직업 하위 카테고리는 합침)
      if (currentTimeSlot) {
        const parsed = this.parseJobSlots(line);
        if (parsed && currentSlots[parsed.job] !== undefined) {
          if (currentSlots[parsed.job].length > 0) {
            currentSlots[parsed.job] = currentSlots[parsed.job].concat(parsed.slots);
          } else {
            currentSlots[parsed.job] = parsed.slots;
          }
        }
      }
    }

    // 마지막 타임슬롯 저장 (pendingComplete: 슬롯 뒤에 #완비가 올 수도 있으므로)
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
        is_complete: (currentIsComplete || pendingComplete) ? 1 : 0,
        raw_message: rawMessage,
        organizer: organizer || senderInfo.name || '',
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

      // 1단계: organizer 기준으로 기존 파티 검색 (room_id 무관 — 다른 방에서 전달된 경우도 매칭)
      let matchId = null;
      if (party.organizer) {
        const byOrganizer = this.db.exec(
          `SELECT id FROM party_posts
           WHERE party_date = ? AND time_slot = ? AND organizer = ?
           ORDER BY updated_at DESC LIMIT 1`,
          [party.party_date, party.time_slot, party.organizer]
        );
        if (byOrganizer.length > 0 && byOrganizer[0].values.length > 0) {
          matchId = byOrganizer[0].values[0][0];
        }
      }

      // 2단계: organizer 매칭 실패 시, 멤버 겹침으로 같은 파티 검색
      if (!matchId) {
        matchId = this._findByMemberOverlap(party);
      }

      if (matchId) {
        this.db.run(
          `UPDATE party_posts SET
           location = ?, party_name = ?,
           warrior_slots = ?, rogue_slots = ?, mage_slots = ?,
           cleric_slots = ?, taoist_slots = ?, requirements = ?,
           is_complete = ?, raw_message = ?, organizer = ?, sender_name = ?,
           updated_at = ?
           WHERE id = ?`,
          [
            party.location, party.party_name,
            party.warrior_slots, party.rogue_slots, party.mage_slots,
            party.cleric_slots, party.taoist_slots, party.requirements,
            party.is_complete, party.raw_message, party.organizer, party.sender_name,
            this._getKoreanDatetime(), matchId
          ]
        );
      } else {
        this.db.run(
          `INSERT INTO party_posts
           (party_date, time_slot, location, party_name,
            warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots,
            requirements, is_complete, raw_message, organizer, sender_name, room_id,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            party.party_date, party.time_slot, party.location, party.party_name,
            party.warrior_slots, party.rogue_slots, party.mage_slots,
            party.cleric_slots, party.taoist_slots,
            party.requirements, party.is_complete, party.raw_message,
            party.organizer, party.sender_name, party.room_id || null,
            this._getKoreanDatetime(), this._getKoreanDatetime()
          ]
        );
      }
    }

    if (parties.length > 0) {
      this.saveDb();
    }

    return parties;
  }

  /**
   * 같은 날짜/시간대에 멤버가 겹치는 기존 파티 검색
   * @returns {number|null} - 매칭된 party_posts.id
   */
  _findByMemberOverlap(party) {
    const candidates = this.db.exec(
      `SELECT id, warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots
       FROM party_posts
       WHERE party_date = ? AND time_slot = ?`,
      [party.party_date, party.time_slot]
    );

    if (!candidates.length || !candidates[0].values.length) return null;

    const newMembers = this._extractFilledMembers(party);
    if (newMembers.size < 2) return null;

    for (const row of candidates[0].values) {
      const existingMembers = this._extractFilledMembersFromRow(row);
      if (existingMembers.size < 2) continue;

      const overlap = [...newMembers].filter(m => existingMembers.has(m)).length;
      // 작은 쪽 기준 50% 이상 겹치고, 최소 2명 이상 겹치면 같은 파티
      const threshold = Math.min(newMembers.size, existingMembers.size) * 0.5;
      if (overlap >= threshold && overlap >= 2) {
        return row[0]; // id
      }
    }

    return null;
  }

  _extractFilledMembers(party) {
    const members = new Set();
    const jobs = ['warrior', 'rogue', 'mage', 'cleric', 'taoist'];
    for (const job of jobs) {
      const slots = this._safeJsonParse(party[`${job}_slots`]);
      for (const s of slots) {
        if (s && s.trim()) members.add(s.trim());
      }
    }
    return members;
  }

  _extractFilledMembersFromRow(row) {
    const members = new Set();
    // row: [id, warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots]
    for (let i = 1; i <= 5; i++) {
      const slots = this._safeJsonParse(row[i]);
      for (const s of slots) {
        if (s && s.trim()) members.add(s.trim());
      }
    }
    return members;
  }

  _isPartyMessage(message) {
    // 파티 모집 메시지 특징 체크
    const indicators = [
      /\d{1,2}[\/\.월]\d{1,2}/,  // 날짜 패턴
      /\d{1,2}[:시]\d{0,2}\s*[~\-]/,  // 시간 패턴
      /\[[^\]]*\]/,  // 슬롯 패턴
      /전사|도적|법사|직자|도가|데빌|딜법|저주|세손|아나테마|무도가/,  // 직업명
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
      afterTime = null,
      returnAll = false,
      skipTimeFilter = false
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
             requirements, is_complete, organizer, sender_name, updated_at, raw_message,
             created_at
      FROM party_posts
      WHERE party_date = ?
    `;
    const params = [targetDate];

    if (!includeComplete) {
      sql += ` AND is_complete = 0`;
    }

    // 현재 시간 이후만 (오늘인 경우, skipTimeFilter가 아닐 때)
    const todayStr = this._formatDate(koreanNow);
    if (!skipTimeFilter && targetDate === todayStr) {
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
      organizer: row[12],
      sender_name: row[13],
      updated_at: row[14],
      raw_message: row[15] || '',
      created_at: row[16]
    }));

    // returnAll이면 전체 반환 (빈자리 없는 파티 포함)
    if (returnAll) {
      const answer = parties.length > 0
        ? this._formatPartyList(targetDate, parties.filter(p => this._countEmptySlots(p, job).total > 0), job)
        : `${this._formatDisplayDate(targetDate)} 파티가 없습니다.`;
      return { answer, parties };
    }

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
      const displayName = party.organizer || (party.sender_name ? party.sender_name.split('/')[0] : '');
      const nameTag = displayName ? `@${displayName}` : '';
      lines.push(`[${locationName}] ${party.time_slot} ${nameTag}`.trim());

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

  getRecentParties(limit = 30) {
    if (!this.db) return [];

    const result = this.db.exec(
      `SELECT id, party_date, time_slot, location, party_name,
              warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots,
              is_complete, organizer, sender_name, room_id,
              created_at, updated_at
       FROM party_posts
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit]
    );

    if (!result.length || !result[0].values.length) return [];

    return result[0].values.map(row => ({
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
      is_complete: row[10],
      organizer: row[11],
      sender_name: row[12],
      room_id: row[13],
      created_at: row[14],
      updated_at: row[15]
    }));
  }

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

  // ── 관리자 CRUD ──────────────────────────────────────

  /**
   * 관리자용 파티 목록 조회 (시간 필터 없이 전체)
   */
  getAllPartiesAdmin(date) {
    if (!this.db) return [];

    let sql = `
      SELECT id, party_date, time_slot, location, party_name,
             warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots,
             requirements, is_complete, organizer, sender_name, room_id,
             raw_message, created_at, updated_at
      FROM party_posts
    `;
    const params = [];

    if (date) {
      sql += ` WHERE party_date = ?`;
      params.push(date);
    }

    sql += ` ORDER BY party_date DESC, time_slot ASC`;

    const result = this.db.exec(sql, params);
    if (!result.length || !result[0].values.length) return [];

    return result[0].values.map(row => ({
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
      organizer: row[12],
      sender_name: row[13],
      room_id: row[14],
      raw_message: row[15],
      created_at: row[16],
      updated_at: row[17]
    }));
  }

  /**
   * 단일 파티 조회
   */
  getPartyById(id) {
    if (!this.db) return null;

    const result = this.db.exec(
      `SELECT id, party_date, time_slot, location, party_name,
              warrior_slots, rogue_slots, mage_slots, cleric_slots, taoist_slots,
              requirements, is_complete, organizer, sender_name, room_id,
              raw_message, created_at, updated_at
       FROM party_posts WHERE id = ?`,
      [id]
    );

    if (!result.length || !result[0].values.length) return null;

    const row = result[0].values[0];
    return {
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
      organizer: row[12],
      sender_name: row[13],
      room_id: row[14],
      raw_message: row[15],
      created_at: row[16],
      updated_at: row[17]
    };
  }

  /**
   * 파티 수정
   */
  updateParty(id, data) {
    if (!this.db) return { success: false };

    try {
      const fields = [];
      const params = [];

      const allowedFields = [
        'party_date', 'time_slot', 'location', 'party_name',
        'warrior_slots', 'rogue_slots', 'mage_slots', 'cleric_slots', 'taoist_slots',
        'requirements', 'is_complete', 'organizer', 'sender_name'
      ];

      const jsonFields = ['warrior_slots', 'rogue_slots', 'mage_slots', 'cleric_slots', 'taoist_slots', 'requirements'];

      for (const field of allowedFields) {
        if (data[field] !== undefined) {
          fields.push(`${field} = ?`);
          if (jsonFields.includes(field)) {
            params.push(typeof data[field] === 'string' ? data[field] : JSON.stringify(data[field]));
          } else {
            params.push(data[field]);
          }
        }
      }

      if (fields.length === 0) return { success: false, message: 'No fields to update' };

      fields.push(`updated_at = ?`);
      params.push(this._getKoreanDatetime());
      params.push(id);

      this.db.run(`UPDATE party_posts SET ${fields.join(', ')} WHERE id = ?`, params);
      this.saveDb();

      return { success: true };
    } catch (e) {
      console.error('updateParty error:', e);
      return { success: false, message: e.message };
    }
  }

  /**
   * 파티 삭제
   */
  deleteParty(id) {
    if (!this.db) return { success: false };

    try {
      this.db.run(`DELETE FROM party_posts WHERE id = ?`, [id]);
      this.saveDb();
      return { success: true };
    } catch (e) {
      console.error('deleteParty error:', e);
      return { success: false, message: e.message };
    }
  }

  // ── 오래된 데이터 정리 ──────────────────────────────────────

  cleanupOldParties(daysToKeep = 7, deleteAll = false) {
    if (!this.db) return { success: false };

    try {
      const before = this.db.exec(`SELECT COUNT(*) FROM party_posts`);
      const beforeCount = before[0]?.values[0]?.[0] || 0;

      let cutoff = null;
      if (deleteAll) {
        this.db.run(`DELETE FROM party_posts`);
      } else {
        const cutoffDate = this._getKoreanDate();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
        cutoff = this._formatDate(cutoffDate);
        this.db.run(`DELETE FROM party_posts WHERE party_date < ?`, [cutoff]);
      }

      const after = this.db.exec(`SELECT COUNT(*) FROM party_posts`);
      const afterCount = after[0]?.values[0]?.[0] || 0;
      const removed = beforeCount - afterCount;

      this.saveDb();

      return {
        success: true,
        // trade.db 정리와 동일한 필드 규약 (deleted/remaining/cutoffDate)
        deleted: removed,
        remaining: afterCount,
        cutoffDate: deleteAll ? '전체' : cutoff,
        // 하위호환
        removed,
        kept: afterCount
      };
    } catch (e) {
      console.error('cleanupOldParties error:', e);
      return { success: false, message: e.message };
    }
  }
}

module.exports = { PartyService };
