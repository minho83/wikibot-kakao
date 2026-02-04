const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class TradeService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../trade.db');
    this.lodDbPath = path.join(__dirname, '../../LOD_DB/lod.db');
    this.db = null;
    this.initialized = false;
    this.saveInterval = null;
    this.aliasMap = new Map(); // alias → canonical_name
    this.knownItems = new Set(); // LOD_DB에서 로드한 아이템명
    this.bundleItems = new Set(); // BundleMaxCount > 0인 묶음거래 아이템 (소모품/재료)
    this.rejectedPatterns = new Set(); // cleanup에서 학습된 거부 패턴
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
      this._loadLodItems(SQL);
      this._loadRejectedPatterns();
      this.initialized = true;

      this.saveInterval = setInterval(() => this.saveDb(), 5 * 60 * 1000);
      console.log('TradeService initialized');
    } catch (error) {
      console.error('Failed to initialize TradeService:', error);
      throw error;
    }
  }

  /**
   * LOD_DB에서 아이템명 로드
   */
  _loadLodItems(SQL) {
    try {
      if (!fs.existsSync(this.lodDbPath)) {
        console.log('LOD_DB not found, skipping item validation');
        return;
      }
      const buf = fs.readFileSync(this.lodDbPath);
      const lodDb = new SQL.Database(buf);
      // DisplayName + BundleMaxCount 로드 (묶음거래 가능 아이템 구분)
      const result = lodDb.exec(`SELECT DISTINCT DisplayName, MAX(CAST(BundleMaxCount AS INTEGER)) as bmc FROM items GROUP BY DisplayName`);
      if (result.length > 0) {
        for (const row of result[0].values) {
          const name = row[0];
          const bundleMax = row[1] || 0;
          this.knownItems.add(name);
          if (bundleMax > 0) this.bundleItems.add(name);
          // 레벨 접미사 제거한 베이스명도 추가 (나겔링반지(Lev1) → 나겔링반지)
          const base = name.replace(/\(Lev\d+\)/, '').trim();
          if (base !== name) {
            this.knownItems.add(base);
            if (bundleMax > 0) this.bundleItems.add(base);
          }
        }
      }
      lodDb.close();
      console.log(`LOD_DB loaded: ${this.knownItems.size} item names (묶음아이템: ${this.bundleItems.size}개)`);
    } catch (e) {
      console.error('Failed to load LOD_DB:', e);
    }
  }

  /**
   * rejected_patterns 테이블에서 학습된 거부 패턴 로드 (3회 이상 거부된 것만)
   */
  _loadRejectedPatterns() {
    try {
      const result = this.db.exec(`SELECT pattern FROM rejected_patterns WHERE reject_count >= 3`);
      if (result.length > 0) {
        for (const row of result[0].values) {
          this.rejectedPatterns.add(row[0]);
        }
      }
      if (this.rejectedPatterns.size > 0) {
        console.log(`Rejected patterns loaded: ${this.rejectedPatterns.size}개`);
      }
    } catch (e) {
      // 테이블 없을 수 있음 (최초 실행)
    }
  }

  /**
   * 알려진 게임 아이템인지 확인
   */
  isKnownItem(name) {
    if (this.knownItems.size === 0) return true; // LOD_DB 없으면 통과
    if (this.knownItems.has(name)) return true;
    // 별칭의 정식명도 허용
    for (const canonical of this.aliasMap.values()) {
      if (canonical === name) return true;
    }
    return false;
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS rejected_patterns (
        pattern TEXT PRIMARY KEY,
        reject_count INTEGER DEFAULT 1,
        last_seen TEXT DEFAULT (datetime('now','localtime')),
        source TEXT DEFAULT 'cleanup'
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
      ['강세', '강화된세피어링', '악세서리'],
      ['강세쌍', '강화된세피어링', '악세서리'],
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
        `INSERT OR REPLACE INTO item_aliases (alias, canonical_name, category) VALUES (?, ?, ?)`,
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
      /^\(?구매자?\s*(에테르?|스피[먼튬]|코어)\s*제공/,  // 부가조건 단독줄
      /^[(\s]*(에테르?|시무)\s*제공/,                    // "에테르 제공" 단독줄
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
    // 교환 패턴 우선 감지 (팝니다+교환 혼합 메시지 대응)
    if (/교환|맞교|↔|⇔/.test(text)) return 'exchange';
    if (/[으로]{1,2}\s*(바꿔|바꿀|교체)/.test(text)) return 'exchange';
    if (/팝니다|팜니다|판매합니다/.test(text)) return 'sell';
    if (/삽니다|구매합니다|구합니다/.test(text)) return 'buy';
    if (/^ㅍ/.test(text.trim())) return 'sell';
    if (/^ㅅ[^ㅅ]/.test(text.trim())) return 'buy';
    return null;
  }

  /**
   * 강화 수치 추출
   */
  _extractEnhancement(text) {
    // N강 패턴
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
    // 아이템명 앞뒤에 붙은 단독 숫자 (예: "9나겔반지", "나겔반지8")
    // 가격으로 쓰이는 큰 숫자(3자리 이상)는 제외
    const prefixMatch = text.match(/^(\d{1,2})([가-힣])/);
    if (prefixMatch && parseInt(prefixMatch[1]) >= 1 && parseInt(prefixMatch[1]) <= 15) {
      return {
        level: parseInt(prefixMatch[1]),
        cleaned: text.replace(/^\d{1,2}/, '').trim()
      };
    }
    const suffixMatch = text.match(/([가-힣])(\d{1,2})$/);
    if (suffixMatch && parseInt(suffixMatch[2]) >= 1 && parseInt(suffixMatch[2]) <= 15) {
      return {
        level: parseInt(suffixMatch[2]),
        cleaned: text.replace(/\d{1,2}$/, '').trim()
      };
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

    // 괄호 안 옵션 (부가조건: 제공/흥정/협의 등)
    const parenMatches = text.match(/\(([^)]+)\)/g);
    if (parenMatches) {
      for (const pm of parenMatches) {
        const inner = pm.slice(1, -1);
        if (/흥정|제공|협의|선택|불가|가능|필수|포함/.test(inner)) {
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
    if (/시무\s*제공/.test(cleaned)) { cleaned = cleaned.replace(/시무\s*제공/g, '').trim(); }
    if (/코어\s*제공/.test(cleaned)) { cleaned = cleaned.replace(/코어\s*제공/g, '').trim(); }
    if (/에테르?\s*제공\s*\d*개?/.test(cleaned)) { cleaned = cleaned.replace(/에테르?\s*제공\s*\d*개?/g, '').trim(); }
    if (/구매자\s*제공/.test(cleaned)) { cleaned = cleaned.replace(/구매자\s*제공/g, '').trim(); }

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
      .replace(/팝니다|삽니다|팜니다|판매합니다|구매합니다|판매|구매|구합니다|구입합니다|팜|삽/g, '')
      .replace(/\d*개당|장당|묶음당|셋당|벌당/g, '')  // 단위 표현 제거 (500개당, 개당, 장당 등)
      .replace(/[•·\-★☆♧◆■□▪▫~.…,]+/g, '')  // 기호/구두점 제거
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

    // URL, 오픈채팅 링크, 특수문자 접두사 제거
    const trimmed = line.trim()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^[→←↑↓⇒⇐▶◀►◄]+\s*/, '')  // 화살표 접두사 제거
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

    // 단위 표현 추출 (개당, 장당 등) → 옵션에 보존
    const unitMatch = remaining.match(/(\d*)(개당|장당|묶음당|셋당|벌당)/);
    const priceUnit = unitMatch ? (unitMatch[1] ? `${unitMatch[1]}${unitMatch[2]}` : unitMatch[2]) : null;

    // 아이템명 정규화
    const itemName = this._normalizeItemName(remaining);
    if (!itemName || itemName.length < 1) return null;

    // 정식명 찾기
    const canonical = this.aliasMap.get(itemName) || itemName;

    // 학습된 거부 패턴 체크
    if (this.rejectedPatterns.has(canonical) || this.rejectedPatterns.has(itemName)) {
      return null;
    }

    // 옵션 합치기 (기존 옵션 + 단위)
    const allOptions = [...optResult.options];
    if (priceUnit) allOptions.push(priceUnit);

    return {
      item_name: remaining.trim() || itemName,
      canonical_name: canonical,
      enhancement: enhResult.level,
      item_level: lvlResult.level,
      item_options: allOptions.length > 0 ? allOptions.join(',') : null,
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

    return this._formatResponse(canonical, enhancement, stats, recentTrades, days, dateLimitStr);
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

    // 3. LOD_DB 아이템명 직접 매칭
    if (this.knownItems.has(searchTerm)) return searchTerm;
    for (const itemName of this.knownItems) {
      if (itemName.includes(searchTerm) && searchTerm.length >= 2) return itemName;
    }

    // 4. DB에서 canonical_name 검색 (LOD_DB 검증된 것 우선)
    const result = this.db.exec(
      `SELECT DISTINCT canonical_name, COUNT(*) as cnt FROM trades
       WHERE canonical_name LIKE ? GROUP BY canonical_name ORDER BY cnt DESC LIMIT 5`,
      [`%${searchTerm}%`]
    );
    if (result.length > 0) {
      // LOD_DB에 있는 아이템 우선
      for (const row of result[0].values) {
        if (this.isKnownItem(row[0])) return row[0];
      }
      // 없으면 거래 건수 가장 많은 것 (최소 5건 이상)
      if (result[0].values[0][1] >= 5) return result[0].values[0][0];
    }

    // 5. item_name 검색
    const result2 = this.db.exec(
      `SELECT DISTINCT canonical_name, COUNT(*) as cnt FROM trades
       WHERE item_name LIKE ? GROUP BY canonical_name ORDER BY cnt DESC LIMIT 5`,
      [`%${searchTerm}%`]
    );
    if (result2.length > 0) {
      for (const row of result2[0].values) {
        if (this.isKnownItem(row[0])) return row[0];
      }
      if (result2[0].values[0][1] >= 5) return result2[0].values[0][0];
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

  /**
   * 이상치 제거 평균 (상하위 10% 제외)
   */
  _trimmedMean(prices) {
    if (prices.length === 0) return 0;
    if (prices.length <= 4) {
      // 4건 이하면 그냥 평균
      return prices.reduce((a, b) => a + b, 0) / prices.length;
    }
    const sorted = [...prices].sort((a, b) => a - b);
    const trimCount = Math.max(1, Math.floor(sorted.length * 0.1));
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  }

  /**
   * 단위 표현 추출용 SQL CASE 절
   */
  _pricingUnitSqlCase() {
    return `CASE
      WHEN item_options LIKE '%1000개당%' THEN '1000개당'
      WHEN item_options LIKE '%500개당%' THEN '500개당'
      WHEN item_options LIKE '%100개당%' THEN '100개당'
      WHEN item_options LIKE '%10개당%' THEN '10개당'
      WHEN item_options LIKE '%개당%' THEN '개당'
      WHEN item_options LIKE '%장당%' THEN '장당'
      WHEN item_options LIKE '%묶음당%' THEN '묶음당'
      WHEN item_options LIKE '%셋당%' THEN '셋당'
      WHEN item_options LIKE '%벌당%' THEN '벌당'
      ELSE ''
    END`;
  }

  _aggregateStats(canonicalName, enhancement, dateLimitStr) {
    const puCase = this._pricingUnitSqlCase();
    let sql = `SELECT price_unit, trade_type, price, ${puCase} as pricing_unit
      FROM trades
      WHERE canonical_name = ? AND trade_date >= ? AND trade_type != 'exchange'`;
    const params = [canonicalName, dateLimitStr];

    if (enhancement !== null && enhancement !== undefined && enhancement > 0) {
      sql += ` AND enhancement = ?`;
      params.push(enhancement);
    }
    sql += ` ORDER BY price`;

    const result = this.db.exec(sql, params);
    if (result.length === 0 || result[0].values.length === 0) return null;

    // 단위별 → 가격단위별 → 거래타입별 그룹화
    const groups = {};
    let totalCount = 0;

    for (const [pu, tradeType, price, pricingUnit] of result[0].values) {
      const puKey = pricingUnit || '';
      if (!groups[puKey]) groups[puKey] = {};
      if (!groups[puKey][pu]) {
        groups[puKey][pu] = { _sellPrices: [], _buyPrices: [], _allPrices: [] };
      }
      const bucket = groups[puKey][pu];
      bucket._allPrices.push(price);
      if (tradeType === 'sell') bucket._sellPrices.push(price);
      else if (tradeType === 'buy') bucket._buyPrices.push(price);
      totalCount++;
    }

    // 통계 계산
    for (const pricingUnit of Object.keys(groups)) {
      for (const pu of Object.keys(groups[pricingUnit])) {
        const b = groups[pricingUnit][pu];
        const stats = {
          count: b._allPrices.length,
          avg: Math.round(this._trimmedMean(b._allPrices) * 10) / 10,
          min: Math.min(...b._allPrices),
          max: Math.max(...b._allPrices),
          sellAvg: null, sellCount: 0,
          buyAvg: null, buyCount: 0
        };
        if (b._sellPrices.length > 0) {
          stats.sellAvg = Math.round(this._trimmedMean(b._sellPrices) * 10) / 10;
          stats.sellCount = b._sellPrices.length;
        }
        if (b._buyPrices.length > 0) {
          stats.buyAvg = Math.round(this._trimmedMean(b._buyPrices) * 10) / 10;
          stats.buyCount = b._buyPrices.length;
        }
        groups[pricingUnit][pu] = stats;
      }
    }

    const puKeys = Object.keys(groups);
    const hasMixedUnits = puKeys.length > 1 || (puKeys.length === 1 && puKeys[0] !== '');

    // ㄱㅈ 데이터 존재 여부
    const hasGjData = puKeys.some(pk => groups[pk]['gj']);

    return { groups, totalCount, hasMixedUnits, hasGjData };
  }

  _getRecentTrades(canonicalName, enhancement, dateLimitStr, limit) {
    let sql = `SELECT trade_type, price, price_unit, enhancement, trade_date, seller_name, item_options
      FROM trades
      WHERE canonical_name = ? AND trade_date >= ? AND trade_type != 'exchange'`;
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
    const puCase = this._pricingUnitSqlCase();

    const result = this.db.exec(`
      SELECT enhancement, item_level, price_unit, trade_type, ${puCase} as pricing_unit,
        COUNT(*) as cnt, AVG(price) as avg_price,
        MIN(price) as min_price, MAX(price) as max_price
      FROM trades
      WHERE canonical_name = ? AND trade_date >= ? AND trade_type != 'exchange'
      GROUP BY enhancement, item_level, price_unit, trade_type, pricing_unit
      ORDER BY enhancement ASC, item_level ASC, cnt DESC
    `, [canonical, dateLimitStr]);

    if (result.length === 0 || result[0].values.length === 0) {
      return { answer: `"${canonical}"의 최근 ${days}일 시세 데이터가 없습니다.`, sources: [] };
    }

    // ㄱㅈ(금전) 데이터 존재 여부 → 없으면 어둠돈
    const hasGjData = result[0].values.some(row => row[2] === 'gj');
    const unitLabels = hasGjData
      ? { gj: 'ㄱㅈ', won: '만원', eok: '억' }
      : { gj: 'ㄱㅈ', won: '어둠돈', eok: '어둠돈(억)' };

    // 단위 종류 파악
    const pricingUnitsSet = new Set();
    for (const row of result[0].values) {
      pricingUnitsSet.add(row[4] || '');
    }
    const hasMixedUnits = pricingUnitsSet.size > 1 || (pricingUnitsSet.size === 1 && !pricingUnitsSet.has(''));

    // 강화 종류 파악 (노강만 있는지 체크)
    const enhancementSet = new Set();
    for (const row of result[0].values) {
      enhancementSet.add(`${row[0] || 0}_${row[1] || 0}`);
    }
    const onlyNoEnhancement = enhancementSet.size === 1 && enhancementSet.has('0_0');

    // 단위별 → 강화+레벨별 그룹화
    const pricingGroups = {};
    for (const row of result[0].values) {
      const [enh, lvl, pu, tradeType, pricingUnit, cnt, avg, min, max] = row;
      const puKey = pricingUnit || '';
      const enhKey = `${enh || 0}_${lvl || 0}`;

      if (!pricingGroups[puKey]) pricingGroups[puKey] = {};
      if (!pricingGroups[puKey][enhKey]) {
        pricingGroups[puKey][enhKey] = { enh: enh || 0, lvl: lvl || 0 };
      }
      const entry = pricingGroups[puKey][enhKey];
      if (!entry[pu]) entry[pu] = { sell: null, buy: null, total: { count: 0, min: Infinity, max: -Infinity } };

      const avgRound = Math.round(avg * 10) / 10;
      if (tradeType === 'sell') {
        entry[pu].sell = { count: cnt, avg: avgRound, min, max };
      } else if (tradeType === 'buy') {
        entry[pu].buy = { count: cnt, avg: avgRound, min, max };
      }
      entry[pu].total.count += cnt;
      entry[pu].total.min = Math.min(entry[pu].total.min, min);
      entry[pu].total.max = Math.max(entry[pu].total.max, max);
    }

    let lines = [`[시세] ${canonical}`];
    lines.push('━━━━━━━━━━━━');

    // 단위 정렬: 구체적 단위(100개당 등) 먼저, 미표기는 마지막
    const sortedPricingUnits = Object.keys(pricingGroups).sort((a, b) => {
      if (a === '' && b !== '') return 1;
      if (a !== '' && b === '') return -1;
      return a.localeCompare(b);
    });

    const isBundleItem = this.bundleItems.has(canonical);

    // 묶음 아이템: 벌크 단위에서 개당 환산가 계산 + 노이즈 개당 데이터 검증
    let crossVal = null;
    if (isBundleItem) {
      crossVal = this._crossValidateUnits(pricingGroups, hasGjData ? 'gj' : 'won');
    }

    for (const pricingUnit of sortedPricingUnits) {
      // 묶음 아이템(소모품/재료)은 단위 미상 데이터 제외
      if (isBundleItem && pricingUnit === '') continue;
      // 교차검증 실패한 [개당] 데이터 제외
      if (isBundleItem && crossVal?.shouldSkipRawPerUnit && pricingUnit === '개당') continue;

      const enhMap = pricingGroups[pricingUnit];
      const enhKeys = Object.keys(enhMap).sort((a, b) => {
        const [ae, al] = a.split('_').map(Number);
        const [be, bl] = b.split('_').map(Number);
        return ae !== be ? ae - be : al - bl;
      });

      // gj 우선, 없으면 won, 없으면 eok
      let displayUnit = 'gj';
      let hasData = enhKeys.some(key => enhMap[key][displayUnit]);
      if (!hasData) { displayUnit = 'won'; hasData = enhKeys.some(key => enhMap[key][displayUnit]); }
      if (!hasData) { displayUnit = 'eok'; hasData = enhKeys.some(key => enhMap[key][displayUnit]); }
      if (!hasData) continue;

      if (hasMixedUnits) {
        lines.push(`\n[${pricingUnit || '기타'}]`);
      }
      lines.push(`${unitLabels[displayUnit]} 기준 (최근 ${days}일)`);

      for (const key of enhKeys) {
        const entry = enhMap[key];
        const data = entry[displayUnit];
        if (!data) continue;

        // 노강만 있는 아이템은 강화 라벨 생략
        let prefix;
        if (onlyNoEnhancement) {
          prefix = '';
        } else {
          let label;
          if (entry.enh === 0 && entry.lvl === 0) label = '노강';
          else if (entry.enh === 0 && entry.lvl > 0) label = `${entry.lvl}렙`;
          else if (entry.lvl > 0) label = `${entry.enh}강 ${entry.lvl}렙`;
          else label = `${entry.enh}강`;
          prefix = `${label}: `;
        }

        const sellStr = data.sell ? `[판]${data.sell.count > 1 ? '평균' : ''}${data.sell.avg}` : null;
        const buyStr = data.buy ? `[구]${data.buy.count > 1 ? '평균' : ''}${data.buy.avg}` : null;

        if (sellStr && buyStr) {
          lines.push(`· ${prefix}${sellStr} ${buyStr} (${data.total.count}건)`);
        } else if (sellStr) {
          lines.push(`· ${prefix}${sellStr} (${data.total.count}건)`);
        } else if (buyStr) {
          lines.push(`· ${prefix}${buyStr} (${data.total.count}건)`);
        }
      }
    }

    // 묶음 아이템: 벌크 단위에서 환산한 개당가 표시
    if (crossVal?.perUnitPrice) {
      if (hasGjData) {
        const priceStr = this._formatPerUnitPrice(crossVal.perUnitPrice);
        lines.push(`\n💰 개당 환산: ${priceStr} (${crossVal.bulkUnit} 기준)`);
      } else {
        // 어둠돈은 원 환산 불가 → 어둠돈 단위로 표시
        const p = crossVal.perUnitPrice;
        const pStr = p % 1 === 0 ? p.toString() : (Math.round(p * 100) / 100).toString();
        lines.push(`\n💰 개당 환산: ~${pStr}어둠돈 (${crossVal.bulkUnit} 기준)`);
      }
    }

    lines.push('');
    if (!onlyNoEnhancement) {
      lines.push('💡 강화별 상세: !가격 5강 ' + canonical.substring(0, 4));
    }

    // 실제 집계 기간 표시
    const dateRange = this.db.exec(
      `SELECT MIN(trade_date), MAX(trade_date) FROM trades WHERE canonical_name = ? AND trade_date >= ? AND trade_type != 'exchange'`,
      [canonical, dateLimitStr]
    );
    let periodStr = `${days}일간`;
    if (dateRange.length > 0 && dateRange[0].values[0][0]) {
      const from = dateRange[0].values[0][0].substring(5).replace('-', '/');
      const to = dateRange[0].values[0][1].substring(5).replace('-', '/');
      periodStr = `${from}~${to}`;
    }
    lines.push(`\n⚠ 거래오픈톡 ${periodStr} 집계 (2건↑ 이상치제거 평균)\n거래에 유의하세요.`);

    return { answer: lines.join('\n').trim(), sources: [] };
  }

  /**
   * item_options에서 단위 표현(개당, 장당 등) 추출
   */
  _extractUnitFromOptions(optionsStr) {
    if (!optionsStr) return '';
    const match = optionsStr.match(/(\d*(?:개당|장당|묶음당|셋당|벌당))/);
    return match ? ` (${match[1]})` : '';
  }

  /**
   * ㄱㅈ 가격을 사람이 읽기 좋은 형태로 변환 (1ㄱㅈ = 1만원 = 10,000원)
   * 0.07ㄱㅈ → "~700원", 0.44ㄱㅈ → "~4,400원", 3.5ㄱㅈ → "~3.5만원(3만5천원)"
   */
  _formatPerUnitPrice(gjPrice) {
    const won = Math.round(gjPrice * 10000);
    if (won < 10000) {
      // 1만원 미만: 원 단위로 표시
      return `~${won.toLocaleString()}원`;
    } else if (gjPrice % 1 === 0) {
      // 딱 떨어지는 만원 단위
      return `~${gjPrice}만원`;
    } else {
      // 만원 이상 소수: 만원+천원 단위
      const man = Math.floor(gjPrice);
      const remainder = won - (man * 10000);
      const cheon = Math.round(remainder / 1000);
      if (cheon === 0) return `~${man}만원`;
      return `~${man}만${cheon}천원`;
    }
  }

  /**
   * 단위 문자열에서 수량 배수 추출 ("100개당" → 100, "개당" → 1, "장당" → 1)
   */
  _getUnitMultiplier(unitStr) {
    if (!unitStr) return 0;
    const match = unitStr.match(/^(\d+)?(?:개당|장당|묶음당|셋당|벌당)$/);
    if (!match) return 0;
    return match[1] ? parseInt(match[1]) : 1;
  }

  /**
   * 묶음 아이템의 단위간 교차검증 — 벌크 단위에서 개당 환산가 계산
   * 원본 [개당] 데이터가 환산가와 5배 이상 차이나면 노이즈로 판정
   * Returns: { perUnitPrice, bulkUnit, shouldSkipRawPerUnit }
   */
  _crossValidateUnits(pricingGroups, displayUnit) {
    // 벌크 단위 중 거래건수 가장 많은 것 찾기
    let bestBulk = null;
    for (const pu of Object.keys(pricingGroups)) {
      const multiplier = this._getUnitMultiplier(pu);
      if (multiplier <= 1) continue; // 개당이나 미표기는 벌크 아님

      const enhMap = pricingGroups[pu];
      let totalCount = 0;
      let sellAvg = null;
      // 노강(0_0) 데이터 기준
      const base = enhMap['0_0'];
      if (base && base[displayUnit]) {
        const data = base[displayUnit];
        totalCount = data.total.count;
        sellAvg = data.sell ? data.sell.avg : (data.buy ? data.buy.avg : null);
      }
      if (sellAvg !== null && (!bestBulk || totalCount > bestBulk.count)) {
        bestBulk = { unit: pu, multiplier, avg: sellAvg, count: totalCount };
      }
    }

    if (!bestBulk) return { perUnitPrice: null, bulkUnit: null, shouldSkipRawPerUnit: false };

    const perUnitPrice = Math.round((bestBulk.avg / bestBulk.multiplier) * 1000) / 1000;

    // 원본 [개당] 데이터와 비교
    let shouldSkipRawPerUnit = false;
    const perUnitGroup = pricingGroups['개당'];
    if (perUnitGroup) {
      const base = perUnitGroup['0_0'];
      if (base && base[displayUnit]) {
        const rawAvg = base[displayUnit].sell?.avg || base[displayUnit].buy?.avg;
        if (rawAvg !== null) {
          const ratio = rawAvg / perUnitPrice;
          if (ratio > 5 || ratio < 0.2) {
            shouldSkipRawPerUnit = true;
          }
        }
      }
    }

    return { perUnitPrice, bulkUnit: bestBulk.unit, shouldSkipRawPerUnit };
  }

  _formatResponse(canonical, enhancement, stats, recentTrades, days, dateLimitStr) {
    // ㄱㅈ 없으면 어둠돈
    const hasGj = stats.hasGjData;
    const unitLabels = hasGj
      ? { gj: 'ㄱㅈ', won: '만원', eok: '억' }
      : { gj: 'ㄱㅈ', won: '어둠돈', eok: '어둠돈(억)' };

    const enhStr = enhancement > 0 ? ` ${enhancement}강` : '';
    let lines = [`[시세] ${canonical}${enhStr}`];
    lines.push('━━━━━━━━━━━━');

    // 단위 정렬: 구체적 단위 먼저, 미표기 마지막
    const sortedPricingUnits = Object.keys(stats.groups).sort((a, b) => {
      if (a === '' && b !== '') return 1;
      if (a !== '' && b === '') return -1;
      return a.localeCompare(b);
    });

    const isBundleItem = this.bundleItems.has(canonical);

    // 묶음 아이템: 벌크 단위에서 개당 환산 + 노이즈 개당 검증
    let crossVal = null;
    if (isBundleItem) {
      const primaryUnit = hasGj ? 'gj' : 'won';
      let bestBulk = null;
      for (const pu of sortedPricingUnits) {
        const multiplier = this._getUnitMultiplier(pu);
        if (multiplier <= 1) continue;
        const unitData = stats.groups[pu]?.[primaryUnit];
        if (!unitData) continue;
        const avg = unitData.sellAvg || unitData.buyAvg;
        if (avg !== null && (!bestBulk || unitData.count > bestBulk.count)) {
          bestBulk = { unit: pu, multiplier, avg, count: unitData.count };
        }
      }
      if (bestBulk) {
        const perUnitPrice = Math.round((bestBulk.avg / bestBulk.multiplier) * 1000) / 1000;
        let shouldSkipRawPerUnit = false;
        const perUnitData = stats.groups['개당']?.[primaryUnit];
        if (perUnitData) {
          const rawAvg = perUnitData.sellAvg || perUnitData.buyAvg;
          if (rawAvg !== null) {
            const ratio = rawAvg / perUnitPrice;
            if (ratio > 5 || ratio < 0.2) shouldSkipRawPerUnit = true;
          }
        }
        crossVal = { perUnitPrice, bulkUnit: bestBulk.unit, shouldSkipRawPerUnit };
      }
    }

    for (const [unitKey, unitLabel] of Object.entries(unitLabels)) {
      // 묶음 아이템(소모품/재료)은 단위 미상 + 노이즈 개당 데이터 제외
      const relevantGroups = sortedPricingUnits.filter(pu => {
        if (isBundleItem && pu === '') return false;
        if (isBundleItem && crossVal?.shouldSkipRawPerUnit && pu === '개당') return false;
        return stats.groups[pu][unitKey];
      });
      if (relevantGroups.length === 0) continue;

      lines.push(`${unitLabel} 기준 (최근 ${days}일)`);

      for (const pricingUnit of relevantGroups) {
        const data = stats.groups[pricingUnit][unitKey];

        if (stats.hasMixedUnits) {
          lines.push(`[${pricingUnit || '기타'}]`);
        }

        if (data.sellAvg !== null && data.buyAvg !== null) {
          lines.push(`· [판] ${data.sellCount > 1 ? '평균 ' : ''}${data.sellAvg} (${data.sellCount}건)`);
          lines.push(`· [구] ${data.buyCount > 1 ? '평균 ' : ''}${data.buyAvg} (${data.buyCount}건)`);
        } else if (data.sellAvg !== null) {
          lines.push(`· [판] ${data.sellCount > 1 ? '평균 ' : ''}${data.sellAvg} (${data.sellCount}건)`);
        } else if (data.buyAvg !== null) {
          lines.push(`· [구] ${data.buyCount > 1 ? '평균 ' : ''}${data.buyAvg} (${data.buyCount}건)`);
        }
        if (data.min !== data.max) {
          lines.push(`· 범위: ${data.min} ~ ${data.max}`);
        }
        lines.push(`· ${data.count}건 집계`);
      }
      lines.push('');
    }

    // 묶음 아이템: 개당 환산가 표시
    if (crossVal?.perUnitPrice) {
      if (hasGj) {
        const priceStr = this._formatPerUnitPrice(crossVal.perUnitPrice);
        lines.push(`💰 개당 환산: ${priceStr} (${crossVal.bulkUnit} 기준)`);
      } else {
        const p = crossVal.perUnitPrice;
        const pStr = p % 1 === 0 ? p.toString() : (Math.round(p * 100) / 100).toString();
        lines.push(`💰 개당 환산: ~${pStr}어둠돈 (${crossVal.bulkUnit} 기준)`);
      }
      lines.push('');
    }

    // 최근 시세
    if (recentTrades.length > 0) {
      lines.push('최근 시세');
      for (const t of recentTrades) {
        const typeTag = t.trade_type === 'sell' ? '[판]' : t.trade_type === 'buy' ? '[구]' : '[교]';
        const tUnitLabel = unitLabels[t.price_unit] || '';
        const dateShort = t.trade_date ? t.trade_date.substring(5).replace('-', '/') : '';
        const unitInfo = this._extractUnitFromOptions(t.item_options);
        lines.push(`· ${typeTag} ${t.price}${tUnitLabel}${unitInfo} (${dateShort})`);
      }
    }

    // 실제 집계 기간 표시
    let enhFilter = '';
    const dateParams = [canonical, dateLimitStr];
    if (enhancement > 0) { enhFilter = ' AND enhancement = ?'; dateParams.push(enhancement); }
    const dateRange = this.db.exec(
      `SELECT MIN(trade_date), MAX(trade_date) FROM trades WHERE canonical_name = ? AND trade_date >= ? AND trade_type != 'exchange'${enhFilter}`,
      dateParams
    );
    let periodStr = `${days}일간`;
    if (dateRange.length > 0 && dateRange[0].values[0][0]) {
      const from = dateRange[0].values[0][0].substring(5).replace('-', '/');
      const to = dateRange[0].values[0][1].substring(5).replace('-', '/');
      periodStr = `${from}~${to}`;
    }
    lines.push(`\n⚠ 거래오픈톡 ${periodStr} 집계 (2건↑ 이상치제거 평균)\n거래에 유의하세요.`);

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

  // ── 데이터 정리 ────────────────────────────────────────

  /**
   * LOD_DB 기반 거래 데이터 정리
   * - canonical_name이 LOD_DB에도 별칭에도 없는 항목 삭제
   * - sinceDate: 이 날짜 이후 데이터만 정리 (없으면 전체)
   */
  cleanupTrades(sinceDate) {
    if (!this.initialized) return { success: false, message: 'not initialized' };
    if (this.knownItems.size === 0) return { success: false, message: 'LOD_DB not loaded' };

    // 별칭 정식명 세트
    const aliasCanonicals = new Set(this.aliasMap.values());

    // 유효한 이름인지 체크
    const isValid = (name) => {
      if (!name) return false;
      if (this.knownItems.has(name)) return true;
      if (aliasCanonicals.has(name)) return true;
      // LOD_DB에서 부분매칭 (2글자 이상 매칭)
      for (const item of this.knownItems) {
        if (item.includes(name) && name.length >= 3) return true;
        if (name.includes(item) && item.length >= 3) return true;
      }
      return false;
    };

    // 정리 대상 조회
    let sql = `SELECT DISTINCT canonical_name, COUNT(*) as cnt FROM trades`;
    if (sinceDate) {
      sql += ` WHERE trade_date >= '${sinceDate}'`;
    }
    sql += ` GROUP BY canonical_name`;

    const result = this.db.exec(sql);
    if (result.length === 0) return { success: true, removed: 0, kept: 0 };

    let removed = 0;
    let kept = 0;
    const removedNames = [];

    for (const row of result[0].values) {
      const [name, cnt] = row;
      if (isValid(name)) {
        kept++;
      } else {
        // 삭제
        if (sinceDate) {
          this.db.run(`DELETE FROM trades WHERE canonical_name = ? AND trade_date >= ?`, [name, sinceDate]);
        } else {
          this.db.run(`DELETE FROM trades WHERE canonical_name = ?`, [name]);
        }
        removed++;
        removedNames.push(`${name}(${cnt}건)`);

        // 거부 패턴 학습
        this.db.run(`
          INSERT INTO rejected_patterns (pattern, reject_count, last_seen, source)
          VALUES (?, 1, datetime('now','localtime'), 'cleanup')
          ON CONFLICT(pattern) DO UPDATE SET
            reject_count = reject_count + 1,
            last_seen = datetime('now','localtime')
        `, [name]);
      }
    }

    // 메모리 캐시 갱신 (3회 이상 거부된 패턴)
    this._loadRejectedPatterns();

    this.saveDb();

    return {
      success: true,
      removed,
      kept,
      removedCount: removedNames.length,
      examples: removedNames.slice(0, 20),
    };
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

  removeAlias(alias) {
    if (!this.initialized) return false;
    try {
      this.db.run(`DELETE FROM item_aliases WHERE alias = ?`, [alias]);
      this.aliasMap.delete(alias);
      this.saveDb();
      return true;
    } catch (e) {
      console.error('Failed to remove alias:', e);
      return false;
    }
  }

  listAliases() {
    if (!this.initialized) return [];
    const result = this.db.exec(`SELECT alias, canonical_name, category FROM item_aliases ORDER BY canonical_name, alias`);
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      alias: row[0], canonical_name: row[1], category: row[2]
    }));
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
    const rejectedCount = this.db.exec(`SELECT COUNT(*) FROM rejected_patterns`);
    const activeRejected = this.db.exec(`SELECT COUNT(*) FROM rejected_patterns WHERE reject_count >= 3`);

    return {
      success: true,
      trades: tradeCount[0]?.values[0][0] || 0,
      items: itemCount[0]?.values[0][0] || 0,
      dateFrom: dateRange[0]?.values[0][0] || null,
      dateTo: dateRange[0]?.values[0][1] || null,
      aliases: aliasCount[0]?.values[0][0] || 0,
      rejectedPatterns: rejectedCount[0]?.values[0][0] || 0,
      activeRejectedPatterns: activeRejected[0]?.values[0][0] || 0,
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
