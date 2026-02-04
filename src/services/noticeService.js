const axios = require('axios');
const cheerio = require('cheerio');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class NoticeService {
    constructor() {
        this.baseUrl = 'http://lod.nexon.com';
        this.paths = {
            notice: '/news/notice',
            update: '/news/update'
        };
        this.dbPath = path.join(__dirname, '../../notice.db');
        this.db = null;
        this.initialized = false;
        this.saveInterval = null;
        // 웹 캐시 (서버 부하 방지)
        this.cache = {};
        this.cacheTTL = 5 * 60 * 1000; // 5분
        // 자동 알림용
        this.lastNotifiedId = { notice: null, update: null };
    }

    // ── 초기화 ──

    async initialize() {
        if (this.initialized) return;
        const SQL = await initSqlJs();

        if (fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(buffer);
        } else {
            this.db = new SQL.Database();
        }

        this._createTables();
        this.initialized = true;
        this.saveInterval = setInterval(() => this._saveDb(), 5 * 60 * 1000);
        console.log('NoticeService DB initialized');
    }

    _createTables() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS notices (
                post_id TEXT NOT NULL,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                category TEXT,
                target_date TEXT,
                post_date TEXT,
                content TEXT,
                link TEXT,
                fetched_at TEXT DEFAULT (datetime('now','localtime')),
                PRIMARY KEY (post_id, type)
            )
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_notices_target
            ON notices(type, target_date)
        `);
    }

    _saveDb() {
        if (!this.db) return;
        try {
            const data = this.db.export();
            fs.writeFileSync(this.dbPath, Buffer.from(data));
        } catch (e) {
            console.error('Failed to save notice DB:', e);
        }
    }

    close() {
        if (this.saveInterval) clearInterval(this.saveInterval);
        this._saveDb();
        if (this.db) this.db.close();
    }

    // ── 제목에서 점검/업데이트 대상 날짜 추출 ──

    _extractTargetDate(title) {
        // "[정기점검] 2/5(목)" → "2/5", "[정식] 12/24(수)" → "12/24"
        const m = title.match(/(\d{1,2})\/(\d{1,2})\s*\(/);
        if (m) return `${parseInt(m[1])}/${parseInt(m[2])}`;
        return null;
    }

    /** target_date "M/D" → Date 객체 (올해 기준) */
    _toDate(targetDate) {
        if (!targetDate) return null;
        const [m, d] = targetDate.split('/').map(Number);
        return new Date(new Date().getFullYear(), m - 1, d);
    }

    // ── DB 저장/조회 ──

    _upsertPost(post, type, content) {
        const targetDate = this._extractTargetDate(post.title);
        this.db.run(
            `INSERT OR REPLACE INTO notices
             (post_id, type, title, category, target_date, post_date, content, link, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
            [post.id, type, post.title, post.category || '', targetDate || '',
             post.date, content, post.link]
        );
    }

    /** DB에서 날짜 기준 검색 (±3일 범위) */
    _searchByDate(type, dateStr) {
        const target = this._toDate(dateStr);
        if (!target) return [];

        const rows = this._queryAll(
            `SELECT * FROM notices WHERE type = ? AND target_date != '' ORDER BY target_date DESC`,
            [type]
        );

        // ±3일 범위 내 결과 필터 + 가까운 순 정렬
        const rangeMs = 3 * 24 * 60 * 60 * 1000;
        return rows
            .map(r => ({ ...r, _targetDate: this._toDate(r.target_date) }))
            .filter(r => r._targetDate && Math.abs(r._targetDate - target) <= rangeMs)
            .sort((a, b) => Math.abs(a._targetDate - target) - Math.abs(b._targetDate - target));
    }

    /** DB에서 최신 N건 조회 */
    _getRecent(type, limit = 5) {
        return this._queryAll(
            `SELECT * FROM notices WHERE type = ? ORDER BY fetched_at DESC LIMIT ?`,
            [type, limit]
        );
    }

    _queryAll(sql, params) {
        const result = this.db.exec(sql, params);
        if (result.length === 0) return [];
        const cols = result[0].columns;
        return result[0].values.map(row => {
            const obj = {};
            cols.forEach((c, i) => { obj[c] = row[i]; });
            return obj;
        });
    }

    // ── 웹 스크래핑 ──

    async fetchList(type) {
        const now = Date.now();
        if (this.cache[type] && now - this.cache[type].fetchedAt < this.cacheTTL) {
            return this.cache[type].data;
        }

        const response = await axios.get(`${this.baseUrl}${this.paths[type]}`, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        const $ = cheerio.load(response.data.toString('utf-8'));
        const results = [];

        $('.board_list li').each((i, el) => {
            const a = $(el).find('a');
            const link = a.attr('href');
            if (!link || !link.startsWith('/News/')) return;

            const title = $(el).find('.tit').text().trim();
            const date = $(el).find('.time').text().trim();
            const category = $(el).find('[class^="bc_type"]').text().trim();
            const idMatch = link.match(/\/(\d+)$/);

            if (title && link) {
                results.push({
                    id: idMatch ? idMatch[1] : null,
                    title, link, date, category
                });
            }
        });

        this.cache[type] = { data: results, fetchedAt: now };
        return results;
    }

    async fetchDetail(link) {
        const response = await axios.get(`${this.baseUrl}${link}`, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        const $ = cheerio.load(response.data.toString('utf-8'));
        const bt = $('.board_text');
        bt.find('script, style').remove();
        bt.find('br').replaceWith('\n');
        bt.find('p').each((i, el) => { $(el).append('\n'); });

        let text = bt.text().trim();
        text = text.replace(/[-=~_]{3,}/g, '---');
        text = text.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
        return text;
    }

    /** 웹에서 목록 가져와서 DB에 저장 (상세 내용 포함) */
    async _fetchAndStore(type) {
        const list = await this.fetchList(type);
        for (const post of list) {
            // DB에 없는 글만 상세 가져오기
            const existing = this._queryAll(
                `SELECT post_id FROM notices WHERE post_id = ? AND type = ?`,
                [post.id, type]
            );
            if (existing.length === 0) {
                try {
                    const content = await this.fetchDetail(post.link);
                    this._upsertPost(post, type, content);
                } catch (e) {
                    // 상세 가져오기 실패해도 목록 정보만 저장
                    this._upsertPost(post, type, '');
                }
            }
        }
        this._saveDb();
        return list;
    }

    // ── 날짜 파싱 ──

    _parseDateQuery(query) {
        if (!query) return null;

        // 주차: "2월 2주차", "2월2주"
        let m = query.match(/(\d{1,2})\s*월\s*(\d)\s*주\s*차?/);
        if (m) return this._getNthThursday(parseInt(m[1]), parseInt(m[2]));

        // "2/5", "2/5일"
        m = query.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
        if (m) return `${parseInt(m[1])}/${parseInt(m[2])}`;

        // "2월5일", "2월 5일"
        m = query.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
        if (m) return `${parseInt(m[1])}/${parseInt(m[2])}`;

        return null;
    }

    _getNthThursday(month, weekNum) {
        const year = new Date().getFullYear();
        const thursdays = [];
        for (let d = 1; d <= 31; d++) {
            const date = new Date(year, month - 1, d);
            if (date.getMonth() !== month - 1) break;
            if (date.getDay() === 4) thursdays.push(date);
        }
        if (weekNum < 1 || weekNum > thursdays.length) return null;
        const t = thursdays[weekNum - 1];
        return `${t.getMonth() + 1}/${t.getDate()}`;
    }

    // ── 공개 API ──

    _truncate(text, max = 700) {
        if (!text) return '';
        return text.length > max ? text.substring(0, max) + '\n...(내용이 길어 생략)' : text;
    }

    /**
     * 공지 가져오기
     * - 인자 없음: 최신 정기점검 공지
     * - 날짜 지정: DB에서 ±3일 범위 검색 (휴일 당겨진 점검 대응)
     */
    async getLatestNotice(query) {
        try {
            if (!this.initialized) await this.initialize();
            const list = await this._fetchAndStore('notice');

            const dateStr = this._parseDateQuery(query);

            if (dateStr) {
                // DB에서 ±3일 범위 검색
                const dbResults = this._searchByDate('notice', dateStr);

                if (dbResults.length > 0) {
                    const main = dbResults[0];
                    const others = dbResults.slice(1, 4);
                    const isExact = main.target_date === dateStr;

                    let nearbyNote = '';
                    if (!isExact) {
                        nearbyNote = `\n(${dateStr} 정확한 공지는 없어 가까운 날짜 ${main.target_date} 결과입니다)\n`;
                    }

                    return {
                        success: true,
                        data: {
                            id: main.post_id,
                            title: main.title,
                            date: main.post_date,
                            category: main.category,
                            content: nearbyNote + this._truncate(main.content),
                            link: `${this.baseUrl}${main.link}`,
                            otherNotices: others.map(r => ({
                                id: r.post_id, title: r.title,
                                date: r.post_date, category: r.category
                            }))
                        }
                    };
                }
                return { success: false, message: `${dateStr} 근처 공지를 찾을 수 없습니다.` };
            }

            // 기본: 최신 정기점검
            if (list.length === 0) {
                return { success: false, message: '공지사항이 없습니다.' };
            }
            const target = list.find(r =>
                r.title.includes('정기점검') || r.category === '점검'
            ) || list[0];

            const dbRow = this._queryAll(
                `SELECT content FROM notices WHERE post_id = ? AND type = 'notice'`,
                [target.id]
            );
            const content = dbRow.length > 0 ? dbRow[0].content : '';

            return {
                success: true,
                data: {
                    id: target.id,
                    title: target.title,
                    date: target.date,
                    category: target.category,
                    content: this._truncate(content),
                    link: `${this.baseUrl}${target.link}`,
                    otherNotices: list.filter(r => r.id !== target.id).slice(0, 3)
                }
            };
        } catch (error) {
            console.error('getLatestNotice error:', error);
            return { success: false, message: '공지사항을 가져오는 중 오류가 발생했습니다.' };
        }
    }

    /**
     * 업데이트 가져오기
     * - 인자 없음: 최신 업데이트
     * - 날짜 지정: DB에서 ±3일 범위 검색
     */
    async getLatestUpdate(query) {
        try {
            if (!this.initialized) await this.initialize();
            const list = await this._fetchAndStore('update');

            const dateStr = this._parseDateQuery(query);

            if (dateStr) {
                const dbResults = this._searchByDate('update', dateStr);

                if (dbResults.length > 0) {
                    const main = dbResults[0];
                    const others = dbResults.slice(1, 4);
                    const isExact = main.target_date === dateStr;

                    let nearbyNote = '';
                    if (!isExact) {
                        nearbyNote = `\n(${dateStr} 정확한 업데이트는 없어 가까운 날짜 ${main.target_date} 결과입니다)\n`;
                    }

                    return {
                        success: true,
                        data: {
                            id: main.post_id,
                            title: main.title,
                            date: main.post_date,
                            category: main.category,
                            content: nearbyNote + this._truncate(main.content),
                            link: `${this.baseUrl}${main.link}`,
                            otherUpdates: others.map(r => ({
                                id: r.post_id, title: r.title, date: r.post_date
                            }))
                        }
                    };
                }
                return { success: false, message: `${dateStr} 근처 업데이트를 찾을 수 없습니다.` };
            }

            if (list.length === 0) {
                return { success: false, message: '업데이트 내역이 없습니다.' };
            }
            const target = list[0];

            const dbRow = this._queryAll(
                `SELECT content FROM notices WHERE post_id = ? AND type = 'update'`,
                [target.id]
            );
            const content = dbRow.length > 0 ? dbRow[0].content : '';

            return {
                success: true,
                data: {
                    id: target.id,
                    title: target.title,
                    date: target.date,
                    content: this._truncate(content),
                    link: `${this.baseUrl}${target.link}`,
                    otherUpdates: list.slice(1, 4)
                }
            };
        } catch (error) {
            console.error('getLatestUpdate error:', error);
            return { success: false, message: '업데이트 내역을 가져오는 중 오류가 발생했습니다.' };
        }
    }

    /**
     * 새 글 체크 (자동 알림용)
     */
    async checkNew(type) {
        try {
            if (!this.initialized) await this.initialize();
            const list = await this._fetchAndStore(type);
            if (list.length === 0) return null;

            const latest = type === 'notice'
                ? list.find(r => r.title.includes('정기점검') || r.category === '점검') || list[0]
                : list[0];

            if (this.lastNotifiedId[type] === latest.id) return null;

            this.lastNotifiedId[type] = latest.id;

            const dbRow = this._queryAll(
                `SELECT content FROM notices WHERE post_id = ? AND type = ?`,
                [latest.id, type]
            );
            const content = dbRow.length > 0 ? dbRow[0].content : '';

            return {
                id: latest.id,
                title: latest.title,
                date: latest.date,
                category: latest.category,
                content: this._truncate(content),
                link: `${this.baseUrl}${latest.link}`
            };
        } catch (error) {
            console.error(`checkNew(${type}) error:`, error);
            return null;
        }
    }
}

module.exports = { NoticeService };
