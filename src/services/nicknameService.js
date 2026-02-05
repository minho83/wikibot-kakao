const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class NicknameService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../nickname.db');
    this.db = null;
    this.initialized = false;
    this.saveInterval = null;
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
            console.warn('nickname.db corrupt, creating fresh DB:', e.message);
            this.db = new SQL.Database();
          }
        } else {
          console.warn('nickname.db is empty (0 bytes), creating fresh DB');
          this.db = new SQL.Database();
        }
      } else {
        this.db = new SQL.Database();
      }

      this.createTables();
      this.initialized = true;

      // 5분마다 DB 파일에 저장
      this.saveInterval = setInterval(() => this.saveDb(), 5 * 60 * 1000);

      console.log('NicknameService initialized');
    } catch (error) {
      console.error('Failed to initialize NicknameService:', error);
      throw error;
    }
  }

  createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS nickname_config (
        room_id TEXT PRIMARY KEY,
        room_name TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS nickname_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        detected_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS admin_config (
        admin_id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS member_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detected_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    // 인덱스 생성
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_history_sender_room
      ON nickname_history(sender_id, room_id)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_member_events_room
      ON member_events(room_id)
    `);
  }

  /**
   * 닉네임 변경 감지
   * @returns {string} 변경 알림 메시지 (변경 없으면 빈 문자열)
   */
  checkNickname(senderName, senderId, roomId) {
    if (!this.initialized) return '';

    // 감시 대상 방인지 확인
    const roomResult = this.db.exec(
      `SELECT room_id FROM nickname_config WHERE room_id = ? AND enabled = 1`,
      [roomId]
    );
    if (roomResult.length === 0 || roomResult[0].values.length === 0) {
      return '';
    }

    // 해당 방에서 이 sender의 마지막 닉네임 조회
    const lastResult = this.db.exec(
      `SELECT sender_name FROM nickname_history
       WHERE sender_id = ? AND room_id = ?
       ORDER BY id DESC LIMIT 1`,
      [senderId, roomId]
    );

    // 첫 기록이면 저장만
    if (lastResult.length === 0 || lastResult[0].values.length === 0) {
      this.db.run(
        `INSERT INTO nickname_history (room_id, sender_id, sender_name) VALUES (?, ?, ?)`,
        [roomId, senderId, senderName]
      );
      this.saveDb();
      return '';
    }

    const lastName = lastResult[0].values[0][0];

    // 닉네임 동일하면 무시
    if (lastName === senderName) {
      return '';
    }

    // 닉네임 변경 감지 → 새 이력 저장
    this.db.run(
      `INSERT INTO nickname_history (room_id, sender_id, sender_name) VALUES (?, ?, ?)`,
      [roomId, senderId, senderName]
    );
    this.saveDb();

    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    return `[닉네임 변경 감지]\n${lastName} → ${senderName}\n(${now})`;
  }

  /**
   * 입퇴장 이벤트 기록 및 알림
   * @returns {string} 알림 메시지 (감시 대상 아니면 빈 문자열)
   */
  logMemberEvent(roomId, userId, nickname, eventType) {
    if (!this.initialized) return '';

    // 감시 대상 방인지 확인
    const roomResult = this.db.exec(
      `SELECT room_id FROM nickname_config WHERE room_id = ? AND enabled = 1`,
      [roomId]
    );
    if (roomResult.length === 0 || roomResult[0].values.length === 0) {
      return '';
    }

    // 이벤트 기록
    this.db.run(
      `INSERT INTO member_events (room_id, user_id, nickname, event_type) VALUES (?, ?, ?, ?)`,
      [roomId, userId, nickname, eventType]
    );
    this.saveDb();

    const label = eventType === 'join' ? '입장' : '퇴장';
    return `[${label}] ${nickname}`;
  }

  /**
   * 특정 방의 닉네임 변경 이력 조회
   */
  getNicknameHistory(roomId, limit = 50) {
    if (!this.initialized) return [];

    const result = this.db.exec(
      `SELECT sender_id, sender_name, detected_at
       FROM nickname_history
       WHERE room_id = ?
       ORDER BY id DESC LIMIT ?`,
      [roomId, limit]
    );

    if (result.length === 0) return [];

    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  /**
   * 특정 사용자의 닉네임 이력 조회
   */
  getUserHistory(senderId, roomId) {
    if (!this.initialized) return [];

    const result = this.db.exec(
      `SELECT sender_name, detected_at
       FROM nickname_history
       WHERE sender_id = ? AND room_id = ?
       ORDER BY id ASC`,
      [senderId, roomId]
    );

    if (result.length === 0) return [];

    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  /**
   * 감시 대상 채팅방 추가
   */
  addRoom(roomId, roomName) {
    if (!this.initialized) return false;

    try {
      this.db.run(
        `INSERT OR REPLACE INTO nickname_config (room_id, room_name, enabled) VALUES (?, ?, 1)`,
        [roomId, roomName || '']
      );
      this.saveDb();
      return true;
    } catch (error) {
      console.error('Failed to add room:', error);
      return false;
    }
  }

  /**
   * 감시 대상 채팅방 제거
   */
  removeRoom(roomId) {
    if (!this.initialized) return false;

    try {
      this.db.run(
        `DELETE FROM nickname_config WHERE room_id = ?`,
        [roomId]
      );
      this.saveDb();
      return true;
    } catch (error) {
      console.error('Failed to remove room:', error);
      return false;
    }
  }

  /**
   * 감시 대상 채팅방 목록
   */
  listRooms() {
    if (!this.initialized) return [];

    const result = this.db.exec(
      `SELECT room_id, room_name, enabled, created_at FROM nickname_config ORDER BY created_at DESC`
    );

    if (result.length === 0) return [];

    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  /**
   * 관리자 확인
   */
  isAdmin(adminId) {
    if (!this.initialized) return false;

    const result = this.db.exec(
      `SELECT admin_id FROM admin_config WHERE admin_id = ?`,
      [adminId]
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  /**
   * 관리자 등록 (관리자가 없을 때만 최초 등록 가능)
   */
  addAdmin(adminId) {
    if (!this.initialized) return { success: false, message: '서비스가 초기화되지 않았습니다.' };

    // 기존 관리자가 있는지 확인
    const existing = this.db.exec(`SELECT COUNT(*) as cnt FROM admin_config`);
    const count = existing[0].values[0][0];

    if (count > 0) {
      // 이미 관리자가 존재하면 기존 관리자만 추가 가능
      if (!this.isAdmin(adminId)) {
        return { success: false, message: '이미 관리자가 등록되어 있습니다. 기존 관리자만 새 관리자를 추가할 수 있습니다.' };
      }
      return { success: false, message: '이미 관리자로 등록되어 있습니다.' };
    }

    try {
      this.db.run(
        `INSERT INTO admin_config (admin_id) VALUES (?)`,
        [adminId]
      );
      this.saveDb();
      return { success: true, message: '관리자로 등록되었습니다.' };
    } catch (error) {
      console.error('Failed to add admin:', error);
      return { success: false, message: '관리자 등록에 실패했습니다.' };
    }
  }

  /**
   * 관리자 목록 및 관리자 방 목록 조회 (시작 알림용)
   */
  getAdminsInfo() {
    if (!this.initialized) return { admins: [], admin_rooms: [] };

    try {
      // 관리자 목록
      const adminResult = this.db.exec(`SELECT admin_id FROM admin_config`);
      const admins = adminResult.length > 0
        ? adminResult[0].values.map(row => row[0])
        : [];

      // 활성화된 감시 방 목록 (관리자 방으로 간주)
      const roomResult = this.db.exec(
        `SELECT room_id FROM nickname_config WHERE enabled = 1`
      );
      const adminRooms = roomResult.length > 0
        ? roomResult[0].values.map(row => row[0])
        : [];

      return { admins, admin_rooms: adminRooms };
    } catch (error) {
      console.error('Failed to get admins info:', error);
      return { admins: [], admin_rooms: [] };
    }
  }

  /**
   * DB 파일에 저장
   */
  saveDb() {
    if (!this.db) return;

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (error) {
      console.error('Failed to save nickname DB:', error);
    }
  }

  /**
   * 서비스 종료 시 정리
   */
  close() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }
    this.saveDb();
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = { NicknameService };
