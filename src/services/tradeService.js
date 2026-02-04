const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class TradeService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../trade.db');
    this.db = null;
    this.initialized = false;
    this.saveInterval = null;
    this.aliasMap = new Map(); // alias → canonical_name
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const SQL = await initSqlJs();

      if (fs.existsSync(this.dbPath)) {
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
      } else {
        this.db = new SQL.Database();
      }

      this._createTables();
      this._seedAliases();
      this._buildAliasIndex();
      this.initialized = true;

      this.saveInterval = setInterval(() => this.saveDb(), 5 * 60 * 1000);
      console.log('TradeService initialized');
    } catch (error) {
      console.error('Failed to initialize TradeService:', error);
      throw error;
    }
  }

  _createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        canonical_name TEXT,
        enhancement INTEGER DEFAULT 0,
        item_level INTEGER DEFAULT 0,
        item_options TEXT,
        trade_type TEXT NOT NULL,
        price REAL,
        price_unit TEXT DEFAULT 'gj',
        price_raw TEXT,
        seller_name TEXT,
        server TEXT,
        trade_date TEXT NOT NULL,
        message_time TEXT,
        source TEXT DEFAULT 'realtime',
        raw_message TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS item_aliases (
        alias TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        category TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS trade_rooms (
        room_id TEXT PRIMARY KEY,
        room_name TEXT,
        collect INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_canonical ON trades(canonical_name, trade_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_item ON trades(item_name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_trades_canonical_enh ON trades(canonical_name, enhancement, price_unit)`);
  }

  _seedAliases() {
    const aliases = [
      // 목걸이
      ['암목', '암흑의목걸이', '악세서리'],
      ['생목', '생명의목걸이', '악세서리'],
      ['용목', '용의목걸이', '악세서리'],
      // 벨트
      ['암벨', '암흑의벨트', '악세서리'],
      ['생벨', '생명의벨트', '악세서리'],
      // 세트
      ['암셋', '암흑세트', '세트'],
      ['생셋', '생명세트', '세트'],
      ['강세', '강화세트', '세트'],
      ['강세쌍', '강화세트', '세트'],
      ['브릴셋', '브릴리언트세트', '세트'],
      ['엘리스셋', '엘리스세트', '세트'],
      ['백갑셋', '백갑옷세트', '세트'],
      ['적갑셋', '적갑옷세트', '세트'],
      ['마좀셋', '마법좀비의상세트', '세트'],
      ['도적갑셋', '도적갑옷세트', '세트'],
      ['도가적갑셋', '도적갑옷세트', '세트'],
      // 투구
      ['주뚜', '주작투구', '방어구'],
      ['주작뚜', '주작투구', '방어구'],
      // 반지
      ['주작', '주작반지', '악세서리'],
      ['주작반지쌍', '주작반지', '악세서리'],
      ['주작쌍', '주작반지', '악세서리'],
      ['나겔반지', '나겔링반지', '악세서리'],
      ['나겔반지쌍', '나겔링반지', '악세서리'],
      ['나겔귀', '나겔링귀걸이', '악세서리'],
      ['나겔각', '나겔링각반', '방어구'],
      ['나겔장', '나겔링장갑', '방어구'],
      ['나겔벨', '나겔링벨트', '악세서리'],
      ['나겔벨트', '나겔링벨트', '악세서리'],
      ['나겔스톤', '나겔링스톤', '재료'],
      ['스컬', '스컬링', '악세서리'],
      ['강시쌍', '강시반지', '악세서리'],
      ['둠륜안', '둠의룬안대', '악세서리'],
      ['둠륜안쌍', '둠의룬안대', '악세서리'],
      // 무기
      ['매프', '매직프람', '무기'],
      ['가지', '가지의무기', '무기'],
      ['돈파', '돈파무기', '무기'],
      ['글럽', '글럽무기', '무기'],
      // 기타 악세
      ['승릴', '승리의릴리', '악세서리'],
      ['승꽃', '승리의꽃', '악세서리'],
      ['승아', '승리의아뮬렛', '악세서리'],
      ['구미호꼬리', '구미호의꼬리', '악세서리'],
      ['악마꼬리', '악마의꼬리', '악세서리'],
      ['테레지아', '테레지아망토', '방어구'],
      ['깃펜', '운명의깃펜', '악세서리'],
      ['운명깃펜', '운명의깃펜', '악세서리'],
      ['보마', '보온마스크', '악세서리'],
      ['보온마', '보온마스크', '악세서리'],
      ['써클릿', '주작의서클릿', '악세서리'],
      ['서클릿', '주작의서클릿', '악세서리'],
      // 재료
      ['에테르', '에테르', '재료'],
      ['에테', '에테르', '재료'],
      ['코어스톤', '코어스톤', '재료'],
      // 방어구
      ['루딘블', '루딘블랙', '방어구'],
      ['루딘', '루딘블랙', '방어구'],
      ['나무꾼쌍', '나무꾼반지', '악세서리'],
    ];

    for (const [alias, canonical, category] of aliases) {
      this.db.run(
        `INSERT OR IGNORE INTO item_aliases (alias, canonical_name, category) VALUES (?, ?, ?)`,
        [alias, canonical, category]
      );
    }
  }

  _buildAliasIndex() {
    this.aliasMap.clear();
    const result = this.db.exec(`SELECT alias, canonical_name FROM item_aliases`);
    if (result.length > 0) {
      for (const row of result[0].values) {
        this.aliasMap.set(row[0], row[1]);
      }
    }
  }

  // ── 메시지 파싱 ──────────────────────────────────────

  /**
   * 스킵할 줄 판별
   */
  _shouldSkipLine(line) {
    if (!line || line.trim().length < 2) return true;
    const trimmed = line.trim();
    const skipPatterns = [
      /^https?:\/\//,
      /님이\s*(들어왔습니다|나갔습니다)/,
      /^메시지가\s*삭제되었습니다/,
      /^카카오톡\s*오픈채팅/,
      /^링크를\s*선택하면/,
      /^불법촬영물/,
      /^동영상\s*또는/,
      /^운영정책을/,
      /오픈톡\s*주세요/,
      /귓\s*(주세요|드렸|드림|말)/,
      /^본[캐케]거래/,
      /인게임.*귓/,
      /사기꾼/i,
      /^🚨/,
      /^🔥/,
      /^\[오픈채팅봇\]/,
      /^[■□◆◇●○☆★\-=~_<>]{3,}/,
      /쿨탐\s*\d+분/,
      /^타인.*사칭/,
      /^3자사기/,
    ];
    return skipPatterns.some(p => p.test(trimmed));
  }

  /**
   * 거래 타입 섹션 헤더 감지
   */
  _detectSectionHeader(line) {
    const trimmed = line.trim();
    // [팝니다], ■팝니다■, [삽니다], ■삽니다■, [교환합니다], [판매], [구합니다]
    if (/^\[?\s*[■◆]*\s*(팝니다|판매|팜)\s*[■◆]*\s*\]?$/.test(trimmed)) return 'sell';
    if (/^\[?\s*[■◆]*\s*(삽니다|구매|구합니다)\s*[■◆]*\s*\]?$/.test(trimmed)) return 'buy';
    if (/^\[?\s*[■◆]*\s*(교환|교환합니다)\s*[■◆]*\s*\]?$/.test(trimmed)) return 'exchange';
    if (/^판매!?\s*$/.test(trimmed)) return 'sell';
    return null;
  }

  /**
   * 인라인 거래 타입 감지
   */
  _detectInlineTradeType(text) {
    if (/팝니다|팜니다|판매합니다/.test(text)) return 'sell';
    if (/삽니다|구매합니다|구합니다/.test(text)) return 'buy';
    if (/^ㅍ/.test(text.trim())) return 'sell';
    if (/^ㅅ[^ㅅ]/.test(text.trim())) return 'buy';
    if (/교환/.test(text)) return 'exchange';
    return null;
  }

  /**
   * 강화 수치 추출
   */
  _extractEnhancement(text) {
    const match = text.match(/(\d{1,2})강/);
    if (match) {
      return {
        level: parseInt(match[1]),
        cleaned: text.replace(/\d{1,2}강/, '').trim()
      };
    }
    if (/노강/.test(text)) {
      return { level: 0, cleaned: text.replace(/노강/, '').trim() };
    }
    return { level: 0, cleaned: text };
  }

  /**
   * 아이템 레벨 추출
   * "1렙", "9/10", "10/11", "10 11쌍" 등
   */
  _extractItemLevel(text) {
    // N렙 패턴
    const lvlMatch = text.match(/(\d+)렙/);
    if (lvlMatch) {
      return {
        level: parseInt(lvlMatch[1]),
        cleaned: text.replace(/\d+렙/, '').trim()
      };
    }
    // N/N 패턴 (나겔반지 9/10쌍 등)
    const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})/);
    if (slashMatch) {
      return {
        level: parseInt(slashMatch[2]),
        cleaned: text.replace(/\d{1,2}\/\d{1,2}/, '').trim()
      };
    }
    // N N쌍 패턴 (나겔반지 10 11쌍 등) - 두 숫자가 연속으로 나오면 레벨
    const spacePairMatch = text.match(/(\d{1,2})\s+(\d{1,2})(?=쌍|셋)/);
    if (spacePairMatch) {
      return {
        level: parseInt(spacePairMatch[2]),
        cleaned: text.replace(/\d{1,2}\s+\d{1,2}/, '').trim()
      };
    }
    return { level: 0, cleaned: text };
  }

  /**
   * 가격 추출
   */
  _extractPrice(text) {
    // 엄돈/비율 패턴 (6250:1 등) → 스킵
    if (/\d{3,}:\d/.test(text)) return null;

    let price = null;
    let unit = null;
    let raw = '';
    let cleaned = text;

    // ㅇㄷ + 억
    let m = text.match(/ㅇㄷ\s*(\d+\.?\d*)\s*억/);
    if (m) {
      price = parseFloat(m[1]);
      unit = 'eok';
      raw = m[0];
      cleaned = text.replace(m[0], '').trim();
      return { price, unit, raw, cleaned };
    }

    // ㄱㅈ + 숫자
    m = text.match(/ㄱㅈ\s*(\d+\.?\d*)/);
    if (m) {
      price = parseFloat(m[1]);
      unit = 'gj';
      raw = m[0];
      cleaned = text.replace(m[0], '').trim();
      return { price, unit, raw, cleaned };
    }

    // 숫자 + ㄱㅈ
    m = text.match(/(\d+\.?\d*)\s*ㄱㅈ/);
    if (m) {
      price = parseFloat(m[1]);
      unit = 'gj';
      raw = m[0];
      cleaned = text.replace(m[0], '').trim();
      return { price, unit, raw, cleaned };
    }

    // 숫자 + 만원
    m = text.match(/(\d+\.?\d*)\s*만\s*원/);
    if (m) {
      price = parseFloat(m[1]);
      unit = 'won';
      raw = m[0];
      cleaned = text.replace(m[0], '').trim();
      return { price, unit, raw, cleaned };
    }

    // 숫자 + 억
    m = text.match(/(\d+\.?\d*)\s*억/);
    if (m) {
      price = parseFloat(m[1]);
      unit = 'eok';
      raw = m[0];
      cleaned = text.replace(m[0], '').trim();
      return { price, unit, raw, cleaned };
    }

    // 숫자 + 장 (장 = ㄱㅈ)
    m = text.match(/(\d+\.?\d*)\s*장에?\s/);
    if (!m) m = text.match(/(\d+\.?\d*)\s*장$/);
    if (m) {
      price = parseFloat(m[1]);
      unit = 'gj';
      raw = m[0];
      cleaned = text.replace(m[0], '').trim();
      return { price, unit, raw, cleaned };
    }

    // 줄 끝에 단독 숫자 (ㄱㅈ 생략된 경우)
    m = text.match(/\s(\d+\.?\d*)\s*$/);
    if (m && parseFloat(m[1]) >= 3 && parseFloat(m[1]) <= 9999) {
      price = parseFloat(m[1]);
      unit = 'gj';
      raw = m[1];
      cleaned = text.replace(/\s\d+\.?\d*\s*$/, '').trim();
      return { price, unit, raw, cleaned };
    }

    return null;
  }

  /**
   * 옵션 추출
   */
  _extractOptions(text) {
    const options = [];
    let cleaned = text;

    // 괄호 안 옵션
    const parenMatches = text.match(/\(([^)]+)\)/g);
    if (parenMatches) {
      for (const pm of parenMatches) {
        const inner = pm.slice(1, -1);
        if (/흥정|제공|협의|선택/.test(inner)) {
          options.push(inner.trim());
          cleaned = cleaned.replace(pm, '').trim();
        }
      }
    }

    // 인라인 옵션
    if (/쌍/.test(cleaned)) { options.push('쌍'); cleaned = cleaned.replace(/쌍/g, '').trim(); }
    if (/셋(?!팅)/.test(cleaned) && !/셋$/.test(cleaned.replace(/셋\s/, ''))) {
      // 셋 as option only if not part of item name like 암셋
    }
    if (/일반/.test(cleaned)) { options.push('일반'); cleaned = cleaned.replace(/일반/g, '').trim(); }
    if (/무형/.test(cleaned)) { options.push('무형'); cleaned = cleaned.replace(/무형/g, '').trim(); }
    if (/시무\s*제공/.test(cleaned)) { options.push('시무제공'); cleaned = cleaned.replace(/시무\s*제공/g, '').trim(); }
    if (/코어\s*제공/.test(cleaned)) { options.push('코어제공'); cleaned = cleaned.replace(/코어\s*제공/g, '').trim(); }
    if (/에테\s*제공/.test(cleaned)) { options.push('에테제공'); cleaned = cleaned.replace(/에테\s*제공/g, '').trim(); }

    return { options, cleaned };
  }

  /**
   * 발신자 정보 추출
   */
  _extractSenderInfo(senderStr) {
    const name = senderStr;
    let level = null;
    let server = null;

    // 슬래시 구분: 닉네임/레벨/서버 또는 닉네임/서버/레벨
    const slashParts = senderStr.split('/').map(s => s.trim());
    if (slashParts.length >= 2) {
      const servers = ['세오', '베라', '도가', '세오의서'];
      for (const part of slashParts) {
        if (/^\d{1,3}$/.test(part)) level = parseInt(part);
        else if (servers.some(s => part.includes(s))) server = part;
      }
      return { name: slashParts[0], level, server };
    }

    // 공백 구분: 닉네임 레벨 서버
    const spaceParts = senderStr.split(/\s+/);
    if (spaceParts.length >= 2) {
      const servers = ['세오', '베라', '도가'];
      for (const part of spaceParts.slice(1)) {
        if (/^\d{1,3}$/.test(part)) level = parseInt(part);
        else if (servers.some(s => part.includes(s))) server = part;
      }
      return { name: spaceParts[0], level, server };
    }

    return { name, level, server };
  }

  /**
   * 아이템명 정규화
   */
  _normalizeItemName(rawName) {
    let name = rawName
      .replace(/^[ㅍㅅㅂ]+\s*/, '')  // ㅍ(팝), ㅅ(삽) 접두사 제거
      .replace(/팝니다|삽니다|팜니다|판매|구매|구합니다|팜|삽/g, '')
      .replace(/[•·\-★☆♧◆■□▪▫]+/g, '')
      .replace(/\b\d{1,2}\b/g, '')   // 잔여 단독 숫자 제거 (레벨 등)
      .replace(/\s+/g, ' ')
      .trim();

    if (!name || name.length < 1) return null;

    // 별칭 매핑
    const canonical = this.aliasMap.get(name);
    if (canonical) return canonical;

    // 부분 매칭: 별칭이 아이템명에 포함된 경우
    for (const [alias, cname] of this.aliasMap) {
      if (name.includes(alias) && alias.length >= 2) {
        return cname;
      }
    }

    return name;
  }

  /**
   * 한 줄 파싱 → 거래 객체 또는 null
   */
  _parseTradeLine(line, defaultTradeType, senderInfo, tradeDate, messageTime) {
    if (this._shouldSkipLine(line)) return null;

    // 섹션 헤더면 null (호출자가 별도 처리)
    if (this._detectSectionHeader(line)) return null;

    // URL 및 오픈채팅 링크 제거
    const trimmed = line.trim()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!trimmed || trimmed.length < 2) return null;

    // 가격 추출
    const priceResult = this._extractPrice(trimmed);
    if (!priceResult || !priceResult.price) return null;

    let remaining = priceResult.cleaned;

    // 강화 추출
    const enhResult = this._extractEnhancement(remaining);
    remaining = enhResult.cleaned;

    // 아이템 레벨 추출
    const lvlResult = this._extractItemLevel(remaining);
    remaining = lvlResult.cleaned;

    // 옵션 추출
    const optResult = this._extractOptions(remaining);
    remaining = optResult.cleaned;

    // 거래 타입
    const inlineType = this._detectInlineTradeType(trimmed);
    const tradeType = inlineType || defaultTradeType || 'sell';

    // 거래 타입 텍스트 제거
    remaining = remaining
      .replace(/팝니다|삽니다|팜니다|판매합니다|구매합니다|구합니다|교환/g, '')
      .trim();

    // 아이템명 정규화
    const itemName = this._normalizeItemName(remaining);
    if (!itemName || itemName.length < 1) return null;

    // 정식명 찾기
    const canonical = this.aliasMap.get(itemName) || itemName;

    return {
      item_name: remaining.trim() || itemName,
      canonical_name: canonical,
      enhancement: enhResult.level,
      item_level: lvlResult.level,
      item_options: optResult.options.length > 0 ? optResult.options.join(',') : null,
      trade_type: tradeType,
      price: priceResult.price,
      price_unit: priceResult.unit,
      price_raw: priceResult.raw,
      seller_name: senderInfo?.name || null,
      server: senderInfo?.server || null,
      trade_date: tradeDate,
      message_time: messageTime || null,
    };
  }

  /**
   * 메시지 전체 파싱 (멀티라인 지원)
   */
  parseMessage(rawMsg, senderInfo, tradeDate, messageTime) {
    const lines = rawMsg.split('\n');
    const trades = [];
    let currentTradeType = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 섹션 헤더 감지
      const sectionType = this._detectSectionHeader(trimmed);
      if (sectionType) {
        currentTradeType = sectionType;
        continue;
      }

      // "or"로 분리된 복수 아이템 처리
      const orParts = trimmed.split(/\s+or\s+/i);
      for (const part of orParts) {
        const trade = this._parseTradeLine(part.trim(), currentTradeType, senderInfo, tradeDate, messageTime);
        if (trade) {
          trades.push(trade);
        }
      }
    }

    return trades;
  }

  // ── 수집 ──────────────────────────────────────────────

  /**
   * 실시간 메시지 수집
   */
  collectMessage(rawMsg, senderInfo, tradeDate, messageTime) {
    if (!this.initialized) return [];

    const trades = this.parseMessage(rawMsg, senderInfo, tradeDate, messageTime);
    if (trades.length > 0) {
      this._insertTrades(trades, 'realtime', rawMsg);
    }
    return trades;
  }

  _insertTrades(trades, source, rawMessage) {
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const t of trades) {
        this.db.run(
          `INSERT INTO trades (item_name, canonical_name, enhancement, item_level, item_options,
            trade_type, price, price_unit, price_raw, seller_name, server,
            trade_date, message_time, source, raw_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            t.item_name, t.canonical_name, t.enhancement, t.item_level, t.item_options,
            t.trade_type, t.price, t.price_unit, t.price_raw, t.seller_name, t.server,
            t.trade_date, t.message_time, source || 'realtime', rawMessage || null
          ]
        );
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      console.error('Failed to insert trades:', e);
    }
  }

  // ── 조회 ──────────────────────────────────────────────

  /**
   * 시세 조회
   */
  queryPrice(query, options = {}) {
    if (!this.initialized) {
      return { answer: '서비스가 초기화되지 않았습니다.', sources: [] };
    }

    const days = options.days || 30;
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - days);
    const dateLimitStr = dateLimit.toISOString().split('T')[0];

    // 쿼리에서 강화 수치 추출
    const enhResult = this._extractEnhancement(query);
    const enhancement = enhResult.level;
    const searchTerm = enhResult.cleaned.trim();

    // 아이템명 매칭
    const canonical = this._findCanonicalName(searchTerm);

    if (!canonical) {
      // 유사 아이템 제안
      const suggestions = this._getSuggestions(searchTerm);
      let answer = `"${query}"에 대한 시세 데이터가 없습니다.`;
      if (suggestions.length > 0) {
        answer += `\n유사 아이템: ${suggestions.join(', ')}`;
      }
      return { answer, sources: [] };
    }

    // 강화 미지정 시 → 강화별 요약
    if (enhancement === null || enhancement === undefined || enhancement === 0) {
      return this._formatEnhancementSummary(canonical, dateLimitStr, days);
    }

    // 강화 지정 시 → 해당 강화만 상세
    const stats = this._aggregateStats(canonical, enhancement, dateLimitStr);
    const recentTrades = this._getRecentTrades(canonical, enhancement, dateLimitStr, 5);

    if (!stats || stats.count === 0) {
      return { answer: `"${canonical}" ${enhancement}강의 최근 ${days}일 시세 데이터가 없습니다.`, sources: [] };
    }

    return this._formatResponse(canonical, enhancement, stats, recentTrades, days);
  }

  _findCanonicalName(searchTerm) {
    if (!searchTerm) return null;

    // 1. 별칭 테이블 직접 매칭
    const alias = this.aliasMap.get(searchTerm);
    if (alias) return alias;

    // 2. 별칭 부분 매칭
    for (const [a, c] of this.aliasMap) {
      if (searchTerm.includes(a) && a.length >= 2) return c;
      if (a.includes(searchTerm) && searchTerm.length >= 2) return c;
    }

    // 3. DB에서 canonical_name 직접 검색
    const result = this.db.exec(
      `SELECT DISTINCT canonical_name FROM trades WHERE canonical_name LIKE ? LIMIT 1`,
      [`%${searchTerm}%`]
    );
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }

    // 4. item_name 검색
    const result2 = this.db.exec(
      `SELECT DISTINCT canonical_name FROM trades WHERE item_name LIKE ? LIMIT 1`,
      [`%${searchTerm}%`]
    );
    if (result2.length > 0 && result2[0].values.length > 0) {
      return result2[0].values[0][0];
    }

    return null;
  }

  _getSuggestions(searchTerm) {
    const result = this.db.exec(
      `SELECT DISTINCT canonical_name, COUNT(*) as cnt FROM trades
       WHERE canonical_name LIKE ? OR item_name LIKE ?
       GROUP BY canonical_name ORDER BY cnt DESC LIMIT 5`,
      [`%${searchTerm}%`, `%${searchTerm}%`]
    );
    if (result.length === 0) return [];
    return result[0].values.map(r => r[0]);
  }

  _aggregateStats(canonicalName, enhancement, dateLimitStr) {
    let sql = `SELECT
      price_unit,
      COUNT(*) as count,
      AVG(price) as avg_price,
      MIN(price) as min_price,
      MAX(price) as max_price
      FROM trades
      WHERE canonical_name = ? AND trade_date >= ?`;
    const params = [canonicalName, dateLimitStr];

    if (enhancement !== null && enhancement !== undefined && enhancement > 0) {
      sql += ` AND enhancement = ?`;
      params.push(enhancement);
    }

    sql += ` GROUP BY price_unit ORDER BY count DESC`;

    const result = this.db.exec(sql, params);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const stats = {};
    let totalCount = 0;
    for (const row of result[0].values) {
      const [pu, cnt, avg, min, max] = row;
      stats[pu] = { count: cnt, avg: Math.round(avg * 10) / 10, min, max };
      totalCount += cnt;
    }

    return { byUnit: stats, count: totalCount };
  }

  _getRecentTrades(canonicalName, enhancement, dateLimitStr, limit) {
    let sql = `SELECT trade_type, price, price_unit, enhancement, trade_date, seller_name, item_options
      FROM trades
      WHERE canonical_name = ? AND trade_date >= ?`;
    const params = [canonicalName, dateLimitStr];

    if (enhancement !== null && enhancement !== undefined && enhancement > 0) {
      sql += ` AND enhancement = ?`;
      params.push(enhancement);
    }

    sql += ` ORDER BY trade_date DESC, id DESC LIMIT ?`;
    params.push(limit);

    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];

    return result[0].values.map(row => ({
      trade_type: row[0],
      price: row[1],
      price_unit: row[2],
      enhancement: row[3],
      trade_date: row[4],
      seller_name: row[5],
      item_options: row[6],
    }));
  }

  _formatEnhancementSummary(canonical, dateLimitStr, days) {
    const unitLabels = { gj: 'ㄱㅈ', won: '만원', eok: '억' };

    // 강화+레벨별 조회
    const result = this.db.exec(`
      SELECT enhancement, item_level, price_unit,
        COUNT(*) as cnt, AVG(price) as avg_price,
        MIN(price) as min_price, MAX(price) as max_price
      FROM trades
      WHERE canonical_name = ? AND trade_date >= ?
      GROUP BY enhancement, item_level, price_unit
      ORDER BY enhancement ASC, item_level ASC, cnt DESC
    `, [canonical, dateLimitStr]);

    if (result.length === 0 || result[0].values.length === 0) {
      return { answer: `"${canonical}"의 최근 ${days}일 시세 데이터가 없습니다.`, sources: [] };
    }

    // 강화+레벨별로 그룹화 (키: "강화_레벨")
    const enhMap = {};
    for (const row of result[0].values) {
      const [enh, lvl, pu, cnt, avg, min, max] = row;
      const key = `${enh || 0}_${lvl || 0}`;
      if (!enhMap[key]) enhMap[key] = { enh: enh || 0, lvl: lvl || 0 };
      enhMap[key][pu] = { count: cnt, avg: Math.round(avg * 10) / 10, min, max };
    }

    let lines = [`[시세] ${canonical}`];
    lines.push('━━━━━━━━━━━━');

    // 정렬: 강화 → 레벨 순
    const enhKeys = Object.keys(enhMap).sort((a, b) => {
      const [ae, al] = a.split('_').map(Number);
      const [be, bl] = b.split('_').map(Number);
      return ae !== be ? ae - be : al - bl;
    });
    const mainUnit = 'gj';

    lines.push(`ㄱㅈ 기준 (최근 ${days}일)`);
    let hasGj = false;
    for (const key of enhKeys) {
      const entry = enhMap[key];
      const data = entry[mainUnit];
      if (!data) continue;
      hasGj = true;
      let label;
      if (entry.enh === 0 && entry.lvl === 0) label = '노강';
      else if (entry.enh === 0 && entry.lvl > 0) label = `${entry.lvl}렙`;
      else if (entry.lvl > 0) label = `${entry.enh}강 ${entry.lvl}렙`;
      else label = `${entry.enh}강`;
      if (data.min !== data.max) {
        lines.push(`· ${label}: 평균 ${data.avg} (${data.min}~${data.max}) ${data.count}건`);
      } else {
        lines.push(`· ${label}: ${data.avg} ${data.count}건`);
      }
    }

    if (!hasGj) {
      lines.pop();
      lines.push(`만원 기준 (최근 ${days}일)`);
      for (const key of enhKeys) {
        const entry = enhMap[key];
        const data = entry['won'];
        if (!data) continue;
        let label;
        if (entry.enh === 0 && entry.lvl === 0) label = '노강';
        else if (entry.enh === 0 && entry.lvl > 0) label = `${entry.lvl}렙`;
        else if (entry.lvl > 0) label = `${entry.enh}강 ${entry.lvl}렙`;
        else label = `${entry.enh}강`;
        if (data.min !== data.max) {
          lines.push(`· ${enhLabel}: 평균 ${data.avg} (${data.min}~${data.max}) ${data.count}건`);
        } else {
          lines.push(`· ${enhLabel}: ${data.avg} ${data.count}건`);
        }
      }
    }

    lines.push('');
    lines.push('💡 강화별 상세: !가격 5강 ' + canonical.substring(0, 4));

    return { answer: lines.join('\n').trim(), sources: [] };
  }

  _formatResponse(canonical, enhancement, stats, recentTrades, days) {
    const unitLabels = { gj: 'ㄱㅈ', won: '만원', eok: '억' };
    const enhStr = enhancement > 0 ? ` ${enhancement}강` : '';
    let lines = [`[시세] ${canonical}${enhStr}`];
    lines.push('━━━━━━━━━━━━');

    // 가격 단위별 통계
    for (const [unit, data] of Object.entries(stats.byUnit)) {
      const label = unitLabels[unit] || unit;
      lines.push(`${label} 기준 (최근 ${days}일)`);
      lines.push(`· 평균: ${data.avg}`);
      if (data.min !== data.max) {
        lines.push(`· 범위: ${data.min} ~ ${data.max}`);
      }
      lines.push(`· ${data.count}건 등록`);
      lines.push('');
    }

    // 최근 거래
    if (recentTrades.length > 0) {
      lines.push('최근 시세');
      for (const t of recentTrades) {
        const typeLabel = t.trade_type === 'sell' ? '판매' : t.trade_type === 'buy' ? '구매' : '교환';
        const unitLabel = unitLabels[t.price_unit] || '';
        const dateShort = t.trade_date ? t.trade_date.substring(5).replace('-', '/') : '';
        const enhLabel = t.enhancement > 0 ? `${t.enhancement}강 ` : '';
        lines.push(`· ${typeLabel} ${enhLabel}${t.price}${unitLabel} (${dateShort})`);
      }
    }

    return { answer: lines.join('\n').trim(), sources: [] };
  }

  // ── 배치 임포트 ──────────────────────────────────────

  /**
   * 카카오톡 내보내기 파일 임포트
   */
  async importKakaoExport(filePath) {
    if (!this.initialized) throw new Error('Service not initialized');
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let currentDate = null;
    let currentMessage = null;
    let totalMessages = 0;
    let totalTrades = 0;
    let batchBuffer = [];
    const BATCH_SIZE = 500;

    for await (const line of rl) {
      // 날짜 헤더
      const dateMatch = line.match(/^-+\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
      if (dateMatch) {
        // 이전 메시지 처리
        if (currentMessage) {
          const trades = this._processImportMessage(currentMessage, currentDate);
          batchBuffer.push(...trades);
          totalMessages++;
        }
        currentDate = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`;
        currentMessage = null;
        continue;
      }

      // 새 메시지 시작
      const msgMatch = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
      if (msgMatch) {
        // 이전 메시지 처리
        if (currentMessage) {
          const trades = this._processImportMessage(currentMessage, currentDate);
          batchBuffer.push(...trades);
          totalMessages++;
        }
        currentMessage = {
          sender: msgMatch[1],
          time: msgMatch[2],
          lines: [msgMatch[3]]
        };
      } else if (currentMessage) {
        // 연속 줄
        currentMessage.lines.push(line);
      }

      // 배치 플러시
      if (batchBuffer.length >= BATCH_SIZE) {
        this._insertTrades(batchBuffer, 'import');
        totalTrades += batchBuffer.length;
        batchBuffer = [];
      }
    }

    // 마지막 메시지 처리
    if (currentMessage) {
      const trades = this._processImportMessage(currentMessage, currentDate);
      batchBuffer.push(...trades);
      totalMessages++;
    }
    if (batchBuffer.length > 0) {
      this._insertTrades(batchBuffer, 'import');
      totalTrades += batchBuffer.length;
    }

    this.saveDb();
    return { messagesParsed: totalMessages, tradesInserted: totalTrades };
  }

  _processImportMessage(msg, currentDate) {
    if (!currentDate) return [];

    const senderInfo = this._extractSenderInfo(msg.sender);
    const fullText = msg.lines.join('\n');

    return this.parseMessage(fullText, senderInfo, currentDate, msg.time);
  }

  // ── 별칭 관리 ────────────────────────────────────────

  addAlias(alias, canonicalName, category) {
    if (!this.initialized) return false;
    try {
      this.db.run(
        `INSERT OR REPLACE INTO item_aliases (alias, canonical_name, category) VALUES (?, ?, ?)`,
        [alias, canonicalName, category || null]
      );
      this.aliasMap.set(alias, canonicalName);
      this.saveDb();
      return true;
    } catch (e) {
      console.error('Failed to add alias:', e);
      return false;
    }
  }

  // ── 시세방 관리 ──────────────────────────────────────

  /**
   * 방 설정 조회: { enabled, collect } 또는 null
   */
  getTradeRoom(roomId) {
    if (!this.initialized) return null;
    const result = this.db.exec(
      `SELECT room_id, collect, enabled FROM trade_rooms WHERE room_id = ? AND enabled = 1`,
      [roomId]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return { room_id: row[0], collect: row[1] === 1, enabled: row[2] === 1 };
  }

  /**
   * 가격 조회 가능한 방인지 확인 (수집방 또는 조회방)
   */
  isPriceRoom(roomId) {
    return this.getTradeRoom(roomId) !== null;
  }

  /**
   * 시세 수집 대상 방인지 확인 (collect=1인 방만)
   */
  isCollectRoom(roomId) {
    const room = this.getTradeRoom(roomId);
    return room !== null && room.collect;
  }

  /**
   * 방 추가 (collect: true=수집+조회, false=조회만)
   */
  addTradeRoom(roomId, roomName, collect) {
    if (!this.initialized) return false;
    try {
      this.db.run(
        `INSERT OR REPLACE INTO trade_rooms (room_id, room_name, collect, enabled) VALUES (?, ?, ?, 1)`,
        [roomId, roomName || '', collect ? 1 : 0]
      );
      this.saveDb();
      return true;
    } catch (e) {
      console.error('Failed to add trade room:', e);
      return false;
    }
  }

  /**
   * 방 제거
   */
  removeTradeRoom(roomId) {
    if (!this.initialized) return false;
    try {
      this.db.run(`DELETE FROM trade_rooms WHERE room_id = ?`, [roomId]);
      this.saveDb();
      return true;
    } catch (e) {
      console.error('Failed to remove trade room:', e);
      return false;
    }
  }

  /**
   * 방 목록
   */
  listTradeRooms() {
    if (!this.initialized) return [];
    const result = this.db.exec(
      `SELECT room_id, room_name, collect, enabled, created_at FROM trade_rooms ORDER BY created_at DESC`
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      room_id: row[0], room_name: row[1], collect: row[2], enabled: row[3], created_at: row[4]
    }));
  }

  // ── 통계 ──────────────────────────────────────────────

  getStats() {
    if (!this.initialized) return { success: false, message: 'not initialized' };

    const tradeCount = this.db.exec(`SELECT COUNT(*) FROM trades`);
    const itemCount = this.db.exec(`SELECT COUNT(DISTINCT canonical_name) FROM trades`);
    const dateRange = this.db.exec(`SELECT MIN(trade_date), MAX(trade_date) FROM trades`);
    const aliasCount = this.db.exec(`SELECT COUNT(*) FROM item_aliases`);

    return {
      success: true,
      trades: tradeCount[0]?.values[0][0] || 0,
      items: itemCount[0]?.values[0][0] || 0,
      dateFrom: dateRange[0]?.values[0][0] || null,
      dateTo: dateRange[0]?.values[0][1] || null,
      aliases: aliasCount[0]?.values[0][0] || 0,
    };
  }

  // ── DB 관리 ──────────────────────────────────────────

  saveDb() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (error) {
      console.error('Failed to save trade DB:', error);
    }
  }

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

module.exports = { TradeService };
