const initSqlJs = require('sql.js');
const fs = require('fs');
const Fuse = require('fuse.js');
const path = require('path');

class SearchService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../LOD_DB/lod.db');
    this.db = null;
    this.fuse = null;
    this.data = [];
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      const SQL = await initSqlJs();
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
      this.loadData();
      this.buildSearchIndex();
      this.initialized = true;
      console.log(`Search index built: ${this.data.length} items loaded`);
    } catch (error) {
      console.error('Failed to initialize search service:', error);
      throw error;
    }
  }

  loadData() {
    // 아이템 로드
    const itemsResult = this.db.exec(`
      SELECT
        DisplayName as name,
        Type as type,
        JobName as job,
        Level as level,
        GenderName as gender,
        Ac as ac,
        MagicDefense as magicDefense,
        Mhp as hp,
        Mmp as mp,
        UpStr as str,
        UpDex as dex,
        UpInt as int,
        UpWis as wis,
        UpCon as con,
        SmallDamage as smallDamage,
        LargeDamage as largeDamage,
        HitRole as hitRole,
        DamRole as damRole,
        Description as description
      FROM items
    `);

    const items = this.resultToObjects(itemsResult);
    items.forEach(item => {
      item.category = 'item';
      item.categoryName = this.getItemCategoryName(item.type);
      if (item.description) item.description = this.stripColorCodes(item.description);
    });

    // 기술 로드 (skills)
    const skillsResult = this.db.exec(`
      SELECT
        s.Name as name,
        s.DisplayName as displayName,
        s.LearnDesc as description
      FROM skills s
    `);

    const skills = this.resultToObjects(skillsResult);
    skills.forEach(skill => {
      skill.category = 'skill';
      skill.categoryName = '기술';
      if (skill.description) skill.description = this.stripColorCodes(skill.description);

      // 기술 습득 조건 조인
      const actionResult = this.db.exec(`
        SELECT NeedLevel, NeedGold, NeedItem, NeedSTR, NeedDEX, NeedINT, NeedWIS, NeedCON
        FROM action_info WHERE ID = '${skill.name.replace(/'/g, "''")}'
      `);

      if (actionResult.length > 0 && actionResult[0].values.length > 0) {
        const actionInfo = this.rowToObject(actionResult[0]);
        skill.needLevel = actionInfo.NeedLevel;
        skill.needGold = actionInfo.NeedGold;
        skill.needItem = actionInfo.NeedItem;
        skill.needStr = actionInfo.NeedSTR;
        skill.needDex = actionInfo.NeedDEX;
        skill.needInt = actionInfo.NeedINT;
        skill.needWis = actionInfo.NeedWIS;
        skill.needCon = actionInfo.NeedCON;
      }
    });

    // 마법 로드 (spells)
    const spellsResult = this.db.exec(`
      SELECT
        s.Name as name,
        s.DisplayName as displayName,
        s.CostMana as costMana,
        s.LearnDesc as description
      FROM spells s
    `);

    const spells = this.resultToObjects(spellsResult);
    spells.forEach(spell => {
      spell.category = 'spell';
      spell.categoryName = '마법';
      if (spell.description) spell.description = this.stripColorCodes(spell.description);

      // 마법 습득 조건 조인
      const actionResult = this.db.exec(`
        SELECT NeedLevel, NeedGold, NeedItem, NeedSTR, NeedDEX, NeedINT, NeedWIS, NeedCON
        FROM action_info WHERE ID = '${spell.name.replace(/'/g, "''")}'
      `);

      if (actionResult.length > 0 && actionResult[0].values.length > 0) {
        const actionInfo = this.rowToObject(actionResult[0]);
        spell.needLevel = actionInfo.NeedLevel;
        spell.needGold = actionInfo.NeedGold;
        spell.needItem = actionInfo.NeedItem;
        spell.needStr = actionInfo.NeedSTR;
        spell.needDex = actionInfo.NeedDEX;
        spell.needInt = actionInfo.NeedINT;
        spell.needWis = actionInfo.NeedWIS;
        spell.needCon = actionInfo.NeedCON;
      }
    });

    this.data = [...items, ...skills, ...spells];
  }

  resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  rowToObject(result) {
    if (!result || result.values.length === 0) return null;
    const columns = result.columns;
    const row = result.values[0];
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  }

  getItemCategoryName(type) {
    const weaponTypes = ['무기'];
    const armorTypes = ['의상', '모자', '장갑', '신발', '각반', '망토'];
    const accessoryTypes = ['목걸이', '반지', '귀걸이', '벨트', '악세서리', '액세서리'];
    const shieldTypes = ['방패'];

    if (weaponTypes.includes(type)) return '무기';
    if (armorTypes.includes(type)) return '방어구';
    if (shieldTypes.includes(type)) return '방패';
    if (accessoryTypes.includes(type)) return '악세서리';
    return type || '기타';
  }

  // 게임 컬러 코드 제거 ({=A ~ {=z)
  stripColorCodes(str) {
    return str.replace(/\{=[A-Za-z]/g, '');
  }

  buildSearchIndex() {
    const options = {
      keys: [
        { name: 'name', weight: 2 },
        { name: 'displayName', weight: 2 },
        { name: 'description', weight: 0.5 }
      ],
      threshold: 0.4,
      distance: 100,
      includeScore: true,
      minMatchCharLength: 1
    };

    this.fuse = new Fuse(this.data, options);
  }

  // 한글 초성 추출
  getChosung(str) {
    const cho = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
    let result = '';

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i) - 44032;
      if (code >= 0 && code <= 11171) {
        result += cho[Math.floor(code / 588)];
      } else {
        result += str[i];
      }
    }
    return result;
  }

  // 초성 검색 여부 확인
  isChosungOnly(str) {
    const chosungRegex = /^[ㄱ-ㅎ]+$/;
    return chosungRegex.test(str);
  }

  search(query, limit = 10) {
    if (!this.initialized) {
      return { success: false, message: '검색 서비스가 초기화되지 않았습니다.' };
    }

    if (!query || query.trim() === '') {
      return { success: false, message: '검색어를 입력해주세요.' };
    }

    const trimmedQuery = query.trim();
    let results = [];

    // 초성 검색인 경우
    if (this.isChosungOnly(trimmedQuery)) {
      results = this.data.filter(item => {
        const name = item.name || item.displayName || '';
        const chosung = this.getChosung(name);
        return chosung.includes(trimmedQuery);
      }).slice(0, limit).map(item => ({ item, score: 0 }));
    } else {
      // 퍼지 검색
      results = this.fuse.search(trimmedQuery, { limit });
    }

    if (results.length === 0) {
      return {
        success: true,
        message: `"${trimmedQuery}" 검색 결과가 없습니다.`,
        results: []
      };
    }

    return {
      success: true,
      query: trimmedQuery,
      count: results.length,
      results: results.map(r => r.item)
    };
  }

  getStats() {
    if (!this.initialized) {
      return { success: false, message: '검색 서비스가 초기화되지 않았습니다.' };
    }

    const itemCount = this.data.filter(d => d.category === 'item').length;
    const skillCount = this.data.filter(d => d.category === 'skill').length;
    const spellCount = this.data.filter(d => d.category === 'spell').length;

    return {
      success: true,
      stats: {
        '아이템': itemCount,
        '기술': skillCount,
        '마법': spellCount,
        '총 데이터': this.data.length
      }
    };
  }
}

module.exports = { SearchService };
