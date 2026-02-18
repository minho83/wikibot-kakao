const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config();

const webhookController = require('./controllers/webhookController');
const { router: nicknameController, setNicknameService } = require('./controllers/nicknameController');
const { SearchService } = require('./services/searchService');
const { CommunityService } = require('./services/communityService');
const { NicknameService } = require('./services/nicknameService');
const { NoticeService } = require('./services/noticeService');
const { TradeService } = require('./services/tradeService');
const { PartyService } = require('./services/partyService');
const { rateLimiter, errorHandler } = require('./middleware');

// ── 관리자 인증 ──────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminTokens = new Set();

function adminAuth(req, res, next) {
  // ADMIN_PASSWORD 미설정 시 인증 없이 통과
  if (!ADMIN_PASSWORD) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ success: false, message: '인증이 필요합니다.' });
  }
  next();
}

// ── 활동 로그 (인메모리 링버퍼) ──────────────────────────
const activityLog = [];
const MAX_ACTIVITY_LOG = 100;

function logActivity(event) {
  const now = new Date();
  const koTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  activityLog.unshift({
    time: koTime.toISOString(),
    ...event
  });
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.pop();
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const searchService = new SearchService();
const communityService = new CommunityService();
const nicknameService = new NicknameService();
const noticeService = new NoticeService();
const tradeService = new TradeService();
const partyService = new PartyService();

// 검색 서비스 초기화
let initialized = false;
const initializeService = async () => {
  if (!initialized) {
    await searchService.initialize();
    await nicknameService.initialize();
    await noticeService.initialize();
    await tradeService.initialize();
    await partyService.initialize();
    setNicknameService(nicknameService);
    initialized = true;
  }
};
initializeService().catch(console.error);

// 게시판 요청 rate limiting (벤 방지)
const communityRateLimit = {
  lastRequest: 0,
  minDelay: 3000, // 최소 3초 간격
  requestCount: 0,
  resetTime: 0,
  maxPerMinute: 10
};

function canMakeCommunityRequest() {
  const now = Date.now();

  // 분당 요청 수 리셋
  if (now - communityRateLimit.resetTime > 60000) {
    communityRateLimit.requestCount = 0;
    communityRateLimit.resetTime = now;
  }

  // 분당 최대 요청 수 체크
  if (communityRateLimit.requestCount >= communityRateLimit.maxPerMinute) {
    return { allowed: false, waitTime: 60000 - (now - communityRateLimit.resetTime) };
  }

  // 최소 딜레이 체크
  const timeSinceLastRequest = now - communityRateLimit.lastRequest;
  if (timeSinceLastRequest < communityRateLimit.minDelay) {
    return { allowed: false, waitTime: communityRateLimit.minDelay - timeSinceLastRequest };
  }

  return { allowed: true };
}

function recordCommunityRequest() {
  communityRateLimit.lastRequest = Date.now();
  communityRateLimit.requestCount++;
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 정적 파일 서빙
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'public')));

// 숫자를 한글 단위로 변환 (예: 150000000 → "1억 5,000만")
function formatGold(num) {
  if (!num || num === 0) return '0';

  const units = ['', '만', '억', '조'];
  const parts = [];
  let remaining = num;
  let unitIndex = 0;

  while (remaining > 0 && unitIndex < units.length) {
    const part = remaining % 10000;
    if (part > 0) {
      const formatted = part.toLocaleString('ko-KR');
      parts.unshift(formatted + units[unitIndex]);
    }
    remaining = Math.floor(remaining / 10000);
    unitIndex++;
  }

  return parts.join(' ') || '0';
}

// RAG 호환 /ask 엔드포인트 (rateLimiter 없이)
app.post('/ask', async (req, res) => {
  try {
    if (!initialized) await initializeService();

    const { query, max_length } = req.body;
    if (!query) {
      return res.status(400).json({ answer: '검색어를 입력해주세요.', sources: [] });
    }

    const result = searchService.search(query);

    if (result.success && result.results && result.results.length > 0) {
      const items = result.results.slice(0, 3);
      let answer = '';
      const sources = [];

      items.forEach((item, idx) => {
        const title = item.displayName || item.name || '제목 없음';
        answer += `${idx + 1}. [${item.categoryName || item.category}] ${title}\n`;

        // 아이템 정보
        if (item.category === 'item') {
          if (item.level) answer += `   레벨: ${item.level}`;
          if (item.job) answer += ` | 직업: ${item.job}\n`;
          if (item.ac != null && item.ac !== 0) answer += `   AC: ${item.ac}`;
          if (item.magicDefense) answer += ` | 마방: ${item.magicDefense}`;
          if (item.smallDamage || item.largeDamage) answer += ` | 데미지: ${item.smallDamage || 0}/${item.largeDamage || 0}`;
          answer += '\n';
          if (item.hitRole || item.damRole || item.hp || item.mp) {
            let line = '  ';
            if (item.hitRole) line += ` 명중: ${item.hitRole}`;
            if (item.damRole) line += ` | 추뎀: ${item.damRole}`;
            if (item.hp) line += ` | HP: ${item.hp}`;
            if (item.mp) line += ` | MP: ${item.mp}`;
            answer += line + '\n';
          }
          const stats = [];
          if (item.str) stats.push(`STR${item.str > 0 ? '+' : ''}${item.str}`);
          if (item.dex) stats.push(`DEX${item.dex > 0 ? '+' : ''}${item.dex}`);
          if (item.int) stats.push(`INT${item.int > 0 ? '+' : ''}${item.int}`);
          if (item.wis) stats.push(`WIS${item.wis > 0 ? '+' : ''}${item.wis}`);
          if (item.con) stats.push(`CON${item.con > 0 ? '+' : ''}${item.con}`);
          if (stats.length > 0) answer += `   스탯: ${stats.join(' ')}\n`;
        }

        // 마법 정보
        if (item.category === 'spell') {
          if (item.costMana) answer += `   MP소모: ${item.costMana.toLocaleString('ko-KR')}\n`;
          if (item.needLevel) answer += `   습득 토탈레벨: ${item.needLevel}`;
          if (item.needGold) answer += ` | 비용: ${formatGold(item.needGold)}G`;
          answer += '\n';
          const stats = [];
          if (item.needStr && item.needStr > 0) stats.push(`STR ${item.needStr}`);
          if (item.needDex && item.needDex > 0) stats.push(`DEX ${item.needDex}`);
          if (item.needInt && item.needInt > 0) stats.push(`INT ${item.needInt}`);
          if (item.needWis && item.needWis > 0) stats.push(`WIS ${item.needWis}`);
          if (item.needCon && item.needCon > 0) stats.push(`CON ${item.needCon}`);
          if (stats.length > 0) answer += `   요구스탯: ${stats.join(' ')}\n`;
          if (item.needItem) answer += `   필요아이템: ${item.needItem}\n`;
        }

        // 기술 정보
        if (item.category === 'skill') {
          if (item.needLevel) answer += `   습득 토탈레벨: ${item.needLevel}`;
          if (item.needGold) answer += ` | 비용: ${formatGold(item.needGold)}G`;
          answer += '\n';
          const stats = [];
          if (item.needStr && item.needStr > 0) stats.push(`STR ${item.needStr}`);
          if (item.needDex && item.needDex > 0) stats.push(`DEX ${item.needDex}`);
          if (item.needInt && item.needInt > 0) stats.push(`INT ${item.needInt}`);
          if (item.needWis && item.needWis > 0) stats.push(`WIS ${item.needWis}`);
          if (item.needCon && item.needCon > 0) stats.push(`CON ${item.needCon}`);
          if (stats.length > 0) answer += `   요구스탯: ${stats.join(' ')}\n`;
          if (item.needItem) answer += `   필요아이템: ${item.needItem}\n`;
        }

        if (item.description) answer += `   ${item.description}\n`;
        sources.push({ title: title, url: item.link || '', score: item.score || 0 });
      });

      if (max_length && answer.length > max_length) {
        answer = answer.substring(0, max_length) + '...';
      }

      res.json({ answer: answer.trim() || '검색 결과가 없습니다.', sources });
    } else {
      res.json({ answer: result.message || '검색 결과가 없습니다.', sources: [] });
    }
  } catch (error) {
    console.error('Ask endpoint error:', error);
    res.status(500).json({ answer: '서버 오류가 발생했습니다.', sources: [] });
  }
});

// 아이템 전용 검색 (/ask/item)
app.post('/ask/item', async (req, res) => {
  try {
    if (!initialized) await initializeService();

    const { query, max_length } = req.body;
    if (!query) {
      return res.status(400).json({ answer: '검색어를 입력해주세요.', sources: [] });
    }

    const result = searchService.search(query);

    if (result.success && result.results && result.results.length > 0) {
      // 아이템만 필터링
      const items = result.results.filter(r => r.category === 'item').slice(0, 5);

      if (items.length === 0) {
        return res.json({ answer: `"${query}" 아이템을 찾을 수 없습니다.`, sources: [] });
      }

      let answer = '';
      const sources = [];

      items.forEach((item, idx) => {
        const title = item.displayName || item.name || '제목 없음';
        answer += `${idx + 1}. [${item.categoryName || '아이템'}] ${title}\n`;

        if (item.level) answer += `   레벨: ${item.level}`;
        if (item.job) answer += ` | 직업: ${item.job}\n`;
        if (item.ac != null && item.ac !== 0) answer += `   AC: ${item.ac}`;
        if (item.magicDefense) answer += ` | 마방: ${item.magicDefense}`;
        if (item.smallDamage || item.largeDamage) answer += ` | 데미지: ${item.smallDamage || 0}/${item.largeDamage || 0}`;
        answer += '\n';
        if (item.hitRole || item.damRole || item.hp || item.mp) {
          let line = '  ';
          if (item.hitRole) line += ` 명중: ${item.hitRole}`;
          if (item.damRole) line += ` | 추뎀: ${item.damRole}`;
          if (item.hp) line += ` | HP: ${item.hp}`;
          if (item.mp) line += ` | MP: ${item.mp}`;
          answer += line + '\n';
        }
        const stats = [];
        if (item.str) stats.push(`STR${item.str > 0 ? '+' : ''}${item.str}`);
        if (item.dex) stats.push(`DEX${item.dex > 0 ? '+' : ''}${item.dex}`);
        if (item.int) stats.push(`INT${item.int > 0 ? '+' : ''}${item.int}`);
        if (item.wis) stats.push(`WIS${item.wis > 0 ? '+' : ''}${item.wis}`);
        if (item.con) stats.push(`CON${item.con > 0 ? '+' : ''}${item.con}`);
        if (stats.length > 0) answer += `   스탯: ${stats.join(' ')}\n`;

        if (item.description) answer += `   ${item.description}\n`;
        sources.push({ title: title, url: '', score: 0 });
      });

      if (max_length && answer.length > max_length) {
        answer = answer.substring(0, max_length) + '...';
      }

      res.json({ answer: answer.trim(), sources });
    } else {
      res.json({ answer: `"${query}" 아이템을 찾을 수 없습니다.`, sources: [] });
    }
  } catch (error) {
    console.error('Item search error:', error);
    res.status(500).json({ answer: '서버 오류가 발생했습니다.', sources: [] });
  }
});

// 스킬/스펠 전용 검색 (/ask/skill)
app.post('/ask/skill', async (req, res) => {
  try {
    if (!initialized) await initializeService();

    const { query, max_length } = req.body;
    if (!query) {
      return res.status(400).json({ answer: '검색어를 입력해주세요.', sources: [] });
    }

    const result = searchService.search(query);

    if (result.success && result.results && result.results.length > 0) {
      // 스킬/스펠만 필터링
      const items = result.results.filter(r => r.category === 'skill' || r.category === 'spell').slice(0, 5);

      if (items.length === 0) {
        return res.json({ answer: `"${query}" 스킬/마법을 찾을 수 없습니다.`, sources: [] });
      }

      let answer = '';
      const sources = [];

      items.forEach((item, idx) => {
        const title = item.displayName || item.name || '제목 없음';
        answer += `${idx + 1}. [${item.categoryName || item.category}] ${title}\n`;

        // 마법/스킬 정보
        if (item.costMana) answer += `   MP소모: ${item.costMana.toLocaleString('ko-KR')}\n`;
        if (item.needLevel) answer += `   습득 토탈레벨: ${item.needLevel}`;
        if (item.needGold) answer += ` | 비용: ${formatGold(item.needGold)}G`;
        answer += '\n';

        // 스탯 요구사항 (0이 아닌 것만)
        const stats = [];
        if (item.needStr && item.needStr > 0) stats.push(`STR ${item.needStr}`);
        if (item.needDex && item.needDex > 0) stats.push(`DEX ${item.needDex}`);
        if (item.needInt && item.needInt > 0) stats.push(`INT ${item.needInt}`);
        if (item.needWis && item.needWis > 0) stats.push(`WIS ${item.needWis}`);
        if (item.needCon && item.needCon > 0) stats.push(`CON ${item.needCon}`);
        if (stats.length > 0) answer += `   요구스탯: ${stats.join(' ')}\n`;

        if (item.needItem) answer += `   필요아이템: ${item.needItem}\n`;
        if (item.description) answer += `   ${item.description}\n`;
        sources.push({ title: title, url: '', score: 0 });
      });

      if (max_length && answer.length > max_length) {
        answer = answer.substring(0, max_length) + '...';
      }

      res.json({ answer: answer.trim(), sources });
    } else {
      res.json({ answer: `"${query}" 스킬/마법을 찾을 수 없습니다.`, sources: [] });
    }
  } catch (error) {
    console.error('Skill search error:', error);
    res.status(500).json({ answer: '서버 오류가 발생했습니다.', sources: [] });
  }
});

// 게시판 검색 (/ask/community) - Rate limiting 적용
app.post('/ask/community', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, answer: '검색어를 입력해주세요.', sources: [] });
    }

    // Rate limiting 체크
    const rateCheck = canMakeCommunityRequest();
    if (!rateCheck.allowed) {
      const waitSec = Math.ceil(rateCheck.waitTime / 1000);
      return res.json({
        success: false,
        message: `서버 보호를 위해 ${waitSec}초 후에 다시 시도해주세요.`,
        answer: `서버 보호를 위해 ${waitSec}초 후에 다시 시도해주세요.`,
        sources: []
      });
    }

    recordCommunityRequest();

    const result = await communityService.searchAndParse(query);

    if (result.success) {
      const data = result.data;
      let answer = `📋 ${data.title}\n`;
      answer += `📅 ${data.date}\n\n`;
      answer += data.content;

      const sources = [{
        title: data.title,
        url: data.link,
        score: 1
      }];

      // 다른 검색 결과도 안내
      if (data.otherResults && data.otherResults.length > 0) {
        answer += '\n\n📌 다른 검색 결과:\n';
        data.otherResults.forEach((r, idx) => {
          answer += `${idx + 2}. ${r.title} (${r.date})\n`;
        });
      }

      res.json({ success: true, data: result.data, answer, sources });
    } else {
      res.json({ success: false, message: result.message, answer: result.message, sources: [] });
    }
  } catch (error) {
    console.error('Community search error:', error);
    res.status(500).json({ success: false, answer: '게시판 검색 중 오류가 발생했습니다.', sources: [] });
  }
});

// 공지사항 조회 (/ask/notice) - Rate limiting 적용
app.post('/ask/notice', async (req, res) => {
  try {
    const rateCheck = canMakeCommunityRequest();
    if (!rateCheck.allowed) {
      const waitSec = Math.ceil(rateCheck.waitTime / 1000);
      return res.json({
        success: false,
        message: `서버 보호를 위해 ${waitSec}초 후에 다시 시도해주세요.`,
        answer: `서버 보호를 위해 ${waitSec}초 후에 다시 시도해주세요.`,
        sources: []
      });
    }
    recordCommunityRequest();

    const { query } = req.body;
    const result = await noticeService.getLatestNotice(query);

    if (result.success) {
      const data = result.data;
      let answer = `[${data.category || '공지'}] ${data.title}\n`;
      answer += `${data.date}\n\n`;
      answer += data.content;
      answer += `\n\n${data.link}`;

      if (data.otherNotices && data.otherNotices.length > 0) {
        answer += '\n\n-- 다른 공지 --\n';
        data.otherNotices.forEach((r, idx) => {
          answer += `${idx + 1}. [${r.category || ''}] ${r.title} (${r.date})\n`;
        });
      }

      res.json({ success: true, data: result.data, answer, sources: [{ title: data.title, url: data.link, score: 1 }] });
    } else {
      res.json({ success: false, message: result.message, answer: result.message, sources: [] });
    }
  } catch (error) {
    console.error('Notice error:', error);
    res.status(500).json({ success: false, answer: '공지사항 조회 중 오류가 발생했습니다.', sources: [] });
  }
});

// 업데이트 내역 조회 (/ask/update)
app.post('/ask/update', async (req, res) => {
  try {
    const rateCheck = canMakeCommunityRequest();
    if (!rateCheck.allowed) {
      const waitSec = Math.ceil(rateCheck.waitTime / 1000);
      return res.json({
        success: false,
        message: `서버 보호를 위해 ${waitSec}초 후에 다시 시도해주세요.`,
        answer: `서버 보호를 위해 ${waitSec}초 후에 다시 시도해주세요.`,
        sources: []
      });
    }
    recordCommunityRequest();

    const { query } = req.body;
    const result = await noticeService.getLatestUpdate(query);

    if (result.success) {
      const data = result.data;
      let answer = `${data.title}\n`;
      answer += `${data.date}\n\n`;
      answer += data.content;
      answer += `\n\n${data.link}`;

      if (data.otherUpdates && data.otherUpdates.length > 0) {
        answer += '\n\n-- 다른 업데이트 --\n';
        data.otherUpdates.forEach((r, idx) => {
          answer += `${idx + 1}. ${r.title} (${r.date})\n`;
        });
      }

      res.json({ success: true, data: result.data, answer, sources: [{ title: data.title, url: data.link, score: 1 }] });
    } else {
      res.json({ success: false, message: result.message, answer: result.message, sources: [] });
    }
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ success: false, answer: '업데이트 조회 중 오류가 발생했습니다.', sources: [] });
  }
});

// 새 공지/업데이트 자동 체크 (/ask/check-new)
// n8n 스케줄러에서 주기적으로 호출하여 새 글이 있으면 알림
app.get('/ask/check-new', async (req, res) => {
  try {
    const noticeResult = await noticeService.checkNew('notice');
    const updateResult = await noticeService.checkNew('update');

    const newItems = [];
    if (noticeResult) newItems.push({ type: 'notice', ...noticeResult });
    if (updateResult) newItems.push({ type: 'update', ...updateResult });

    if (newItems.length === 0) {
      return res.json({ hasNew: false, message: '새로운 공지/업데이트가 없습니다.' });
    }

    // 알림 메시지 조합
    let message = '';
    for (const item of newItems) {
      const label = item.type === 'notice' ? '공지' : '업데이트';
      message += `[새 ${label}] ${item.title}\n`;
      message += `${item.date}\n\n`;
      message += item.content;
      message += `\n\n${item.link}\n\n`;
    }

    res.json({ hasNew: true, count: newItems.length, message: message.trim(), items: newItems });
  } catch (error) {
    console.error('Check new error:', error);
    res.status(500).json({ hasNew: false, message: '확인 중 오류가 발생했습니다.' });
  }
});

// ── DB 검색 API (웹 UI용) ──────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    if (!initialized) await initializeService();

    const { q, category, limit } = req.query;
    if (!q || !q.trim()) {
      return res.json({ success: false, message: '검색어를 입력해주세요.', results: [] });
    }

    const maxLimit = Math.min(parseInt(limit) || 20, 50);
    const result = searchService.search(q.trim(), maxLimit);

    if (result.success && result.results) {
      let filtered = result.results;
      if (category && category !== 'all') {
        filtered = filtered.filter(item => item.category === category);
      }
      res.json({
        success: true,
        query: result.query,
        count: filtered.length,
        results: filtered
      });
    } else {
      res.json({ success: true, query: q.trim(), count: 0, results: [], message: result.message });
    }
  } catch (error) {
    console.error('Search API error:', error);
    res.status(500).json({ success: false, message: '검색 중 오류가 발생했습니다.', results: [] });
  }
});

// ── 거래 시세 API ──────────────────────────────────────

// 실시간 거래 메시지 수집
app.post('/api/trade/collect', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { message, sender_name, sender_level, server, trade_date, message_time } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message required' });

    const senderInfo = { name: sender_name, level: sender_level, server };
    const date = trade_date || new Date().toISOString().split('T')[0];
    const trades = tradeService.collectMessage(message, senderInfo, date, message_time);

    if (trades.length > 0) {
      logActivity({
        type: 'trade_collect',
        summary: `거래 ${trades.length}건 수집`,
        count: trades.length,
        sender: sender_name || ''
      });
    }

    res.json({ success: true, count: trades.length });
  } catch (error) {
    console.error('Trade collect error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 시세 조회
app.post('/api/trade/query', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { query, days } = req.body;
    if (!query) return res.status(400).json({ answer: '아이템명을 입력해주세요.', sources: [] });

    const result = tradeService.queryPrice(query, { days: days || 30 });
    res.json(result);
  } catch (error) {
    console.error('Trade query error:', error);
    res.status(500).json({ answer: '시세 조회 중 오류가 발생했습니다.', sources: [] });
  }
});

// 배치 임포트
app.post('/api/trade/import', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { file_path } = req.body;
    if (!file_path) return res.status(400).json({ success: false, message: 'file_path required' });

    const stats = await tradeService.importKakaoExport(file_path);
    res.json({ success: true, ...stats });
  } catch (error) {
    console.error('Trade import error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 거래 통계
app.get('/api/trade/stats', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    res.json(tradeService.getStats());
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 데이터 정리 (LOD_DB 기반)
app.post('/api/trade/cleanup', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { since_date } = req.body || {};
    const result = tradeService.cleanupTrades(since_date);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 별칭 추가
app.post('/api/trade/alias', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { alias, canonical_name, category } = req.body;
    if (!alias || !canonical_name) {
      return res.status(400).json({ success: false, message: 'alias and canonical_name required' });
    }
    const result = tradeService.addAlias(alias, canonical_name, category);
    res.json({ success: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 별칭 삭제
app.delete('/api/trade/alias/:alias', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const result = tradeService.removeAlias(req.params.alias);
    res.json({ success: result, message: result ? '별칭이 삭제되었습니다.' : '삭제 실패' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 별칭 목록
app.get('/api/trade/alias', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const aliases = tradeService.listAliases();
    res.json({ success: true, aliases });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 가격 방 설정 확인
app.post('/api/trade/room-check', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { room_id } = req.body;
    const room = tradeService.getTradeRoom(room_id);
    res.json({ success: true, room });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 가격 방 추가
app.post('/api/trade/rooms', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { room_id, room_name, collect } = req.body;
    if (!room_id) return res.status(400).json({ success: false, message: 'room_id required' });
    const result = tradeService.addTradeRoom(room_id, room_name, !!collect);
    const mode = collect ? '수집+조회' : '조회';
    res.json({ success: result, message: result ? `가격 ${mode}방이 추가되었습니다.` : '추가 실패' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 가격 방 제거
app.delete('/api/trade/rooms/:roomId', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const result = tradeService.removeTradeRoom(req.params.roomId);
    res.json({ success: result, message: result ? '가격방이 제거되었습니다.' : '제거 실패' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 가격 방 목록
app.get('/api/trade/rooms', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    res.json({ success: true, rooms: tradeService.listTradeRooms() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 파티 모집 API ──────────────────────────────────────

// 파티 빈자리 조회 (웹페이지용)
app.get('/api/party/vacancy', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { date, job, include_complete, return_all, skip_time } = req.query;
    const includeComplete = include_complete === '1';
    const returnAll = return_all === '1';
    const skipTimeFilter = skip_time === '1';

    const result = partyService.queryParties({
      date: date || '오늘',
      job: job || null,
      includeComplete,
      returnAll,
      skipTimeFilter
    });

    // 빈자리 정보를 포함한 파티 목록 반환
    const partiesWithVacancies = (result.parties || []).map(p => {
      const vacancies = { total: 0 };
      const jobs = ['warrior', 'rogue', 'mage', 'cleric', 'taoist'];
      for (const j of jobs) {
        const slots = p[`${j}_slots`] || [];
        const empty = slots.filter(s => s === '').length;
        vacancies[j] = empty;
        vacancies.total += empty;
      }
      return { ...p, vacancies };
    });

    const stats = partyService.getStats();

    res.json({
      success: true,
      date: date || partyService._formatDate(partyService._getKoreanDate()),
      parties: partiesWithVacancies,
      stats
    });
  } catch (error) {
    console.error('Party vacancy error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티 메시지 수집
app.post('/api/party/collect', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { message, sender_name, room_id } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message required' });

    const senderInfo = { name: sender_name };
    const parties = partyService.collectMessage(message, senderInfo, room_id);

    if (parties.length > 0) {
      const first = parties[0];
      logActivity({
        type: 'party_collect',
        summary: `파티 ${parties.length}건: ${first.party_date || ''} ${first.time_slot || ''} @${first.organizer || sender_name || ''}`,
        count: parties.length,
        room_id: room_id || '',
        sender: sender_name || ''
      });
    }

    res.json({ success: true, count: parties.length });
  } catch (error) {
    console.error('Party collect error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티 조회
app.post('/api/party/query', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { date, job } = req.body;

    const result = partyService.queryParties({ date, job });
    res.json(result);
  } catch (error) {
    console.error('Party query error:', error);
    res.status(500).json({ answer: '파티 조회 중 오류가 발생했습니다.', parties: [] });
  }
});

// 파티방 설정 확인
app.post('/api/party/room-check', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { room_id } = req.body;
    const room = partyService.getPartyRoom(room_id);
    res.json({ success: true, room });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티방 추가
app.post('/api/party/rooms', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { room_id, room_name, collect } = req.body;
    if (!room_id) return res.status(400).json({ success: false, message: 'room_id required' });
    const result = partyService.addPartyRoom(room_id, room_name, !!collect);
    const mode = collect ? '수집+조회' : '조회';
    res.json({ success: result, message: result ? `파티 ${mode}방이 추가되었습니다.` : '추가 실패' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티방 제거
app.delete('/api/party/rooms/:roomId', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const result = partyService.removePartyRoom(req.params.roomId);
    res.json({ success: result, message: result ? '파티방이 제거되었습니다.' : '제거 실패' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티방 목록
app.get('/api/party/rooms', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    res.json({ success: true, rooms: partyService.listPartyRooms() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티 통계
app.get('/api/party/stats', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    res.json(partyService.getStats());
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 오래된 파티 정리
app.post('/api/party/cleanup', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { days_to_keep, delete_all } = req.body || {};
    const result = partyService.cleanupOldParties(days_to_keep || 7, !!delete_all);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 관리자 인증 API ──────────────────────────────────────

// 로그인
app.post('/api/admin/auth', (req, res) => {
  // ADMIN_PASSWORD 미설정 시 인증 없이 통과
  if (!ADMIN_PASSWORD) {
    return res.json({ success: true, token: 'no-auth' });
  }
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ success: true, token });
});

// 토큰 검증
app.get('/api/admin/verify', (req, res) => {
  // ADMIN_PASSWORD 미설정 시 항상 통과
  if (!ADMIN_PASSWORD) return res.json({ success: true });
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ success: false });
  }
  res.json({ success: true });
});

// 활동 로그 조회
app.get('/api/admin/activity', adminAuth, (req, res) => {
  res.json({ success: true, activities: activityLog });
});

// 서버 상태 (모니터링용)
app.get('/api/admin/status', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const fs = require('fs');
    const path = require('path');

    const mem = process.memoryUsage();
    const dbFiles = ['nickname.db', 'notice.db', 'trade.db', 'party.db'];
    const databases = {};

    for (const dbFile of dbFiles) {
      const dbPath = path.join(__dirname, '..', dbFile);
      try {
        const fileStat = fs.statSync(dbPath);
        databases[dbFile] = {
          size_bytes: fileStat.size,
          size_mb: (fileStat.size / 1024 / 1024).toFixed(2),
          modified: fileStat.mtime.toISOString()
        };
      } catch (e) {
        databases[dbFile] = { size_bytes: 0, size_mb: '0.00', error: 'not found' };
      }
    }

    // 레코드 수
    try { databases['trade.db'].records = tradeService.getStats().trades || 0; } catch (e) {}
    try {
      const ps = partyService.getStats();
      databases['party.db'].records = ps.total_parties || 0;
      databases['party.db'].today = ps.today_parties || 0;
    } catch (e) {}
    try { databases['nickname.db'].rooms = nicknameService.listRooms().length; } catch (e) {}

    // 수집방 정보
    const partyRooms = partyService.listPartyRooms();
    const tradeRooms = tradeService.listTradeRooms();

    res.json({
      success: true,
      uptime: process.uptime(),
      memory: {
        rss_mb: (mem.rss / 1024 / 1024).toFixed(1),
        heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(1),
        heap_total_mb: (mem.heapTotal / 1024 / 1024).toFixed(1)
      },
      databases,
      rooms: { party: partyRooms, trade: tradeRooms }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 최근 수집된 파티 (모니터링용)
app.get('/api/admin/recent-parties', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const parties = partyService.getRecentParties(limit);
    res.json({ success: true, parties });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 시세 모니터링 API (admin) ─────────────────────────

app.get('/api/admin/trade-overview', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const items = tradeService.getMarketOverview(days);
    res.json({ success: true, items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/trade-recent', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const trades = tradeService.getRecentTrades(limit);
    res.json({ success: true, trades });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/admin/trade-volume', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const days = Math.min(parseInt(req.query.days) || 14, 60);
    const volume = tradeService.getDailyVolume(days);
    res.json({ success: true, volume });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 파티 관리 API (admin) ──────────────────────────────

// 관리자용 파티 목록 (시간 필터 없이 전체)
app.get('/api/party/admin/list', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { date } = req.query;
    const parties = partyService.getAllPartiesAdmin(date || null);
    res.json({ success: true, parties });
  } catch (error) {
    console.error('Party admin list error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 단일 파티 조회
app.get('/api/party/admin/:id', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const party = partyService.getPartyById(parseInt(req.params.id));
    if (!party) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, party });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티 수정
app.put('/api/party/admin/:id', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const result = partyService.updateParty(parseInt(req.params.id), req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 파티 삭제
app.delete('/api/party/admin/:id', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const result = partyService.deleteParty(parseInt(req.params.id));
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.use('/api/nickname', nicknameController);
app.use('/webhook', rateLimiter, webhookController);

// ── DB 통계 API (대시보드용) ──────────────────────────────
app.get('/api/db/stats', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const fs = require('fs');
    const path = require('path');

    const dbFiles = ['nickname.db', 'notice.db', 'trade.db', 'party.db'];
    const stats = {};

    for (const dbFile of dbFiles) {
      const dbPath = path.join(__dirname, '..', dbFile);
      try {
        const fileStat = fs.statSync(dbPath);
        stats[dbFile] = {
          size_bytes: fileStat.size,
          size_mb: (fileStat.size / 1024 / 1024).toFixed(2),
          modified: fileStat.mtime.toISOString()
        };
      } catch (e) {
        stats[dbFile] = { size_bytes: 0, size_mb: '0.00', modified: null, error: 'not found' };
      }
    }

    // 레코드 수 추가
    try {
      const tradeStats = tradeService.getStats();
      stats['trade.db'].records = tradeStats.trades || 0;
    } catch (e) { stats['trade.db'].records = 0; }

    try {
      const partyStats = partyService.getStats();
      stats['party.db'].records = partyStats.total_parties || 0;
    } catch (e) { stats['party.db'].records = 0; }

    // 닉네임 DB 레코드 수
    try {
      const nicknameRooms = nicknameService.listRooms();
      stats['nickname.db'].rooms = nicknameRooms.length;
    } catch (e) { stats['nickname.db'].rooms = 0; }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      databases: stats
    });
  } catch (error) {
    console.error('DB stats error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DB 통계 히스토리 저장 (대시보드 그래프용)
const dbStatsHistory = [];
const MAX_HISTORY = 288; // 24시간 * 12 (5분마다)

function recordDbStats() {
  try {
    const fs = require('fs');
    const path = require('path');
    const now = new Date();

    const entry = {
      timestamp: now.toISOString(),
      hour: now.getHours(),
      minute: now.getMinutes()
    };

    const dbFiles = ['nickname.db', 'notice.db', 'trade.db', 'party.db'];
    for (const dbFile of dbFiles) {
      const dbPath = path.join(__dirname, '..', dbFile);
      try {
        const fileStat = fs.statSync(dbPath);
        entry[dbFile] = fileStat.size;
      } catch (e) {
        entry[dbFile] = 0;
      }
    }

    dbStatsHistory.push(entry);
    if (dbStatsHistory.length > MAX_HISTORY) {
      dbStatsHistory.shift();
    }
  } catch (e) {
    console.error('recordDbStats error:', e);
  }
}

// 5분마다 DB 통계 기록
setInterval(recordDbStats, 5 * 60 * 1000);
// 시작 시 즉시 기록
setTimeout(recordDbStats, 5000);

app.get('/api/db/history', (req, res) => {
  res.json({
    success: true,
    history: dbStatsHistory
  });
});

// ── Notion 위키 API ──────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const wikiCache = { data: null, expires: 0, children: {} };
const WIKI_CACHE_TTL = 30 * 60 * 1000; // 30분

async function notionApi(endpoint) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.notion.com',
      path: endpoint,
      headers: {
        'Authorization': 'Bearer ' + NOTION_TOKEN,
        'Notion-Version': '2022-06-28'
      }
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function fetchAllChildren(blockId) {
  let all = [];
  let cursor = undefined;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const data = await notionApi(`/v1/blocks/${blockId}/children${qs}`);
    if (data.results) all = all.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

// 위키 캐시 프리로드 (서버 시작 시 + stale-while-revalidate)
async function preloadWikiCache() {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) return;
  const topBlocks = await fetchAllChildren(NOTION_PAGE_ID);
  const colLists = topBlocks.filter(b => b.type === 'column_list' && b.has_children);
  await Promise.all(colLists.map(async block => {
    block._columns = await fetchAllChildren(block.id);
    await Promise.all(block._columns.filter(c => c.has_children).map(async col => {
      col._children = await fetchAllChildren(col.id);
    }));
  }));
  wikiCache.data = topBlocks;
  wikiCache.expires = Date.now() + WIKI_CACHE_TTL;
  console.log('Wiki cache preloaded');
}

// 위키 최상위 블록 (캐싱)
app.get('/api/wiki', async (req, res) => {
  try {
    if (!NOTION_TOKEN || !NOTION_PAGE_ID) {
      return res.json({ success: false, message: 'Notion 설정이 없습니다.' });
    }
    if (wikiCache.data) {
      const isExpired = Date.now() >= wikiCache.expires;
      if (isExpired) {
        // stale-while-revalidate: 즉시 응답 후 백그라운드 갱신
        res.json({ success: true, blocks: wikiCache.data, cached: true });
        preloadWikiCache().catch(e => console.error('Wiki background refresh error:', e));
        return;
      }
      return res.json({ success: true, blocks: wikiCache.data, cached: true });
    }

    // 첫 요청 시 로드
    await preloadWikiCache();
    res.json({ success: true, blocks: wikiCache.data, cached: false });
  } catch (error) {
    console.error('Wiki API error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 특정 블록의 자식 (토글 펼치기용)
app.get('/api/wiki/blocks/:blockId', async (req, res) => {
  try {
    if (!NOTION_TOKEN) {
      return res.json({ success: false, message: 'Notion 설정이 없습니다.' });
    }
    const { blockId } = req.params;
    const now = Date.now();
    const cached = wikiCache.children[blockId];
    if (cached && now < cached.expires) {
      return res.json({ success: true, blocks: cached.data, cached: true });
    }

    const children = await fetchAllChildren(blockId);

    // 자식 중 has_children인 블록도 1단계 더 가져옴
    for (const child of children) {
      if (child.has_children && ['toggle', 'bulleted_list_item', 'numbered_list_item', 'column_list', 'quote', 'callout'].includes(child.type)) {
        child._children = await fetchAllChildren(child.id);
      }
    }

    wikiCache.children[blockId] = { data: children, expires: now + WIKI_CACHE_TTL };
    res.json({ success: true, blocks: children, cached: false });
  } catch (error) {
    console.error('Wiki block error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 위키 캐시 초기화
app.post('/api/wiki/refresh', (req, res) => {
  wikiCache.data = null;
  wikiCache.expires = 0;
  wikiCache.children = {};
  res.json({ success: true, message: '위키 캐시가 초기화되었습니다.' });
});

// ── LOD DB 관리 API ──────────────────────────────────────

// multer 설정: 임시 디렉토리에 업로드
const lodUpload = multer({
  dest: path.join(__dirname, '..', 'LOD_DB', 'tmp'),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.db') || file.originalname.endsWith('.sqlite') || file.originalname.endsWith('.sqlite3')) {
      cb(null, true);
    } else {
      cb(new Error('DB 파일(.db, .sqlite)만 업로드 가능합니다.'));
    }
  }
});

// LOD DB 내용 조회 API (아이템/기술/마법 브라우징)
app.get('/api/lod/items', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { page = 1, limit = 50, search, type, job } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit) || 50));

    let items = searchService.data.filter(d => d.category === 'item');
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.name || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));
    }
    if (type) items = items.filter(i => i.type === type);
    if (job) items = items.filter(i => i.job === job);

    const total = items.length;
    const offset = (p - 1) * l;
    const paged = items.slice(offset, offset + l);

    res.json({ success: true, total, page: p, limit: l, pages: Math.ceil(total / l), results: paged });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/lod/skills', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { page = 1, limit = 50, search } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit) || 50));

    let items = searchService.data.filter(d => d.category === 'skill');
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.name || '').toLowerCase().includes(q) || (i.displayName || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));
    }

    const total = items.length;
    const offset = (p - 1) * l;
    const paged = items.slice(offset, offset + l);

    res.json({ success: true, total, page: p, limit: l, pages: Math.ceil(total / l), results: paged });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/lod/spells', adminAuth, async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { page = 1, limit = 50, search } = req.query;
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit) || 50));

    let items = searchService.data.filter(d => d.category === 'spell');
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.name || '').toLowerCase().includes(q) || (i.displayName || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));
    }

    const total = items.length;
    const offset = (p - 1) * l;
    const paged = items.slice(offset, offset + l);

    res.json({ success: true, total, page: p, limit: l, pages: Math.ceil(total / l), results: paged });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// LOD DB 정보 조회
app.get('/api/lod/info', adminAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const lodPath = path.join(__dirname, '..', 'LOD_DB', 'lod.db');

    let fileInfo = null;
    try {
      const stat = fs.statSync(lodPath);
      fileInfo = {
        size_bytes: stat.size,
        size_mb: (stat.size / 1024 / 1024).toFixed(2),
        modified: stat.mtime.toISOString()
      };
    } catch (e) {
      fileInfo = { error: 'DB 파일 없음' };
    }

    const stats = searchService.getStats();

    res.json({
      success: true,
      file: fileInfo,
      data: stats.success ? stats.stats : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// LOD DB 업로드 및 교체
app.post('/api/lod/upload', adminAuth, lodUpload.single('dbfile'), async (req, res) => {
  const fs = require('fs');

  if (!req.file) {
    return res.status(400).json({ success: false, message: '파일이 없습니다.' });
  }

  const uploadedPath = req.file.path;
  const lodDir = path.join(__dirname, '..', 'LOD_DB');
  const lodPath = path.join(lodDir, 'lod.db');
  const backupPath = path.join(lodDir, `lod_backup_${Date.now()}.db`);

  try {
    // 1. 업로드된 파일이 유효한 SQLite DB인지 검증
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(uploadedPath);
    const testDb = new SQL.Database(buffer);

    // items, skills, spells, action_info 테이블 존재 확인
    const requiredTables = ['items', 'skills', 'spells', 'action_info'];
    const tablesResult = testDb.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const existingTables = tablesResult.length > 0 ? tablesResult[0].values.map(v => v[0]) : [];

    const missing = requiredTables.filter(t => !existingTables.includes(t));
    if (missing.length > 0) {
      testDb.close();
      fs.unlinkSync(uploadedPath);
      return res.status(400).json({
        success: false,
        message: `필수 테이블 누락: ${missing.join(', ')}`
      });
    }

    // 간단한 데이터 수 확인
    const counts = {};
    for (const table of requiredTables) {
      const r = testDb.exec(`SELECT COUNT(*) FROM ${table}`);
      counts[table] = r.length > 0 ? r[0].values[0][0] : 0;
    }
    testDb.close();

    // 2. 기존 DB 백업
    if (fs.existsSync(lodPath)) {
      fs.copyFileSync(lodPath, backupPath);
    }

    // 3. 새 DB로 교체
    fs.copyFileSync(uploadedPath, lodPath);
    fs.unlinkSync(uploadedPath);

    // 4. SearchService 재초기화
    searchService.initialized = false;
    searchService.db = null;
    searchService.fuse = null;
    searchService.data = [];
    await searchService.initialize();

    // 5. 오래된 백업 정리 (최근 3개만 유지)
    const backups = fs.readdirSync(lodDir)
      .filter(f => f.startsWith('lod_backup_') && f.endsWith('.db'))
      .sort()
      .reverse();

    backups.slice(3).forEach(f => {
      try { fs.unlinkSync(path.join(lodDir, f)); } catch (e) { /* ignore */ }
    });

    res.json({
      success: true,
      message: 'DB 업데이트 완료',
      counts,
      backup: path.basename(backupPath),
      totalLoaded: searchService.data.length
    });
  } catch (error) {
    // 업로드 파일 정리
    try { fs.unlinkSync(uploadedPath); } catch (e) { /* ignore */ }

    // 백업에서 복원 시도
    if (fs.existsSync(backupPath) && !fs.existsSync(lodPath)) {
      try {
        fs.copyFileSync(backupPath, lodPath);
        searchService.initialized = false;
        await searchService.initialize();
      } catch (e) { /* ignore */ }
    }

    res.status(500).json({ success: false, message: 'DB 업로드 실패: ' + error.message });
  }
});

// LOD DB 백업 목록
app.get('/api/lod/backups', adminAuth, (req, res) => {
  try {
    const fs = require('fs');
    const lodDir = path.join(__dirname, '..', 'LOD_DB');
    const backups = fs.readdirSync(lodDir)
      .filter(f => f.startsWith('lod_backup_') && f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(lodDir, f));
        return {
          name: f,
          size_mb: (stat.size / 1024 / 1024).toFixed(2),
          created: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => b.created.localeCompare(a.created));

    res.json({ success: true, backups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// LOD DB 백업 복원
app.post('/api/lod/restore', adminAuth, async (req, res) => {
  const fs = require('fs');
  const { backup_name } = req.body;
  if (!backup_name) return res.status(400).json({ success: false, message: 'backup_name 필요' });

  const lodDir = path.join(__dirname, '..', 'LOD_DB');
  const backupPath = path.join(lodDir, backup_name);
  const lodPath = path.join(lodDir, 'lod.db');

  // path traversal 방지
  if (!backup_name.startsWith('lod_backup_') || backup_name.includes('..')) {
    return res.status(400).json({ success: false, message: '잘못된 백업 파일명' });
  }

  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ success: false, message: '백업 파일 없음' });
  }

  try {
    fs.copyFileSync(backupPath, lodPath);

    searchService.initialized = false;
    searchService.db = null;
    searchService.fuse = null;
    searchService.data = [];
    await searchService.initialize();

    res.json({
      success: true,
      message: `${backup_name}에서 복원 완료`,
      totalLoaded: searchService.data.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '복원 실패: ' + error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use(errorHandler);

// 공지/업데이트 자동 체크 스케줄러 (개별 스케줄)
function startNoticeScheduler() {
  const webhookUrl = process.env.NOTICE_WEBHOOK_URL;
  const dayNames = ['일','월','화','수','목','금','토'];

  // 공지: 화 17:05
  const noticeSchedule = (process.env.NOTICE_SCHEDULE || '2-17:05').split(',').map(s => {
    const [d, t] = s.trim().split('-');
    const [h, m] = t.split(':');
    return { day: Number(d), hour: Number(h), minute: Number(m) };
  });
  // 업데이트: 수 17:00, 목 10:00
  const updateSchedule = (process.env.UPDATE_SCHEDULE || '3-17:00,4-10:00').split(',').map(s => {
    const [d, t] = s.trim().split('-');
    const [h, m] = t.split(':');
    return { day: Number(d), hour: Number(h), minute: Number(m) };
  });

  const checked = new Set();

  setInterval(async () => {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hour}-${minute}`;

    // 공지 체크
    const noticeMatch = noticeSchedule.some(s => s.day === day && s.hour === hour && s.minute === minute);
    const noticeKey = `notice-${timeKey}`;
    if (noticeMatch && !checked.has(noticeKey)) {
      checked.add(noticeKey);
      console.log(`[NoticeScheduler] 공지 자동 체크 (${now.toLocaleString('ko-KR')})`);
      await runCheck('notice', webhookUrl);
    }

    // 업데이트 체크
    const updateMatch = updateSchedule.some(s => s.day === day && s.hour === hour && s.minute === minute);
    const updateKey = `update-${timeKey}`;
    if (updateMatch && !checked.has(updateKey)) {
      checked.add(updateKey);
      console.log(`[NoticeScheduler] 업데이트 자동 체크 (${now.toLocaleString('ko-KR')})`);
      await runCheck('update', webhookUrl);
    }

    // 오래된 키 정리 (24시간 이상 지난 것)
    if (checked.size > 100) checked.clear();
  }, 60 * 1000);

  const noticeDesc = noticeSchedule.map(s => `${dayNames[s.day]} ${s.hour}:${String(s.minute).padStart(2,'0')}`).join(', ');
  const updateDesc = updateSchedule.map(s => `${dayNames[s.day]} ${s.hour}:${String(s.minute).padStart(2,'0')}`).join(', ');
  console.log(`[NoticeScheduler] 공지 체크: ${noticeDesc}`);
  console.log(`[NoticeScheduler] 업데이트 체크: ${updateDesc}`);
}

async function runCheck(type, webhookUrl) {
  try {
    const result = await noticeService.checkNew(type);
    if (!result) {
      console.log(`[NoticeScheduler] 새 ${type} 없음`);
      return;
    }

    const label = type === 'notice' ? '공지' : '업데이트';
    const message = `[새 ${label}] ${result.title}\n${result.date}\n\n${result.content}\n\n${result.link}`;

    console.log(`[NoticeScheduler] 새 ${label} 발견: ${result.title}`);

    if (webhookUrl) {
      try {
        const axios = require('axios');
        await axios.post(webhookUrl, { message, type, item: result });
        console.log(`[NoticeScheduler] 웹훅 전송 완료 (${label})`);
      } catch (webhookError) {
        console.error(`[NoticeScheduler] 웹훅 전송 실패:`, webhookError.message);
      }
    }
  } catch (error) {
    console.error(`[NoticeScheduler] ${type} 체크 오류:`, error.message);
  }
}

// DB 자동 정리 스케줄러 (매일 새벽 4시)
function startDbCleanupScheduler() {
  const checked = new Set();

  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    if (hour === 4 && minute === 0 && !checked.has(dateKey)) {
      checked.add(dateKey);
      console.log(`[DbCleanup] 일일 정리 시작 (${now.toLocaleString('ko-KR')})`);

      // 1. 오래된 거래 데이터 삭제 (14일 이전)
      try {
        const tradeResult = tradeService.cleanupOldTrades(14);
        if (tradeResult.success) {
          console.log(`[DbCleanup] trade.db: ${tradeResult.deleted}개 삭제, ${tradeResult.remaining}개 유지 (기준: ${tradeResult.cutoffDate})`);
        }
      } catch (error) {
        console.error(`[DbCleanup] trade.db 정리 오류:`, error.message);
      }

      // 2. 오래된 파티 데이터 삭제 (7일 이전)
      try {
        const partyResult = partyService.cleanupOldParties(2);
        if (partyResult.success) {
          console.log(`[DbCleanup] party.db: ${partyResult.deleted}개 삭제, ${partyResult.remaining}개 유지 (기준: ${partyResult.cutoffDate})`);
        }
      } catch (error) {
        console.error(`[DbCleanup] party.db 정리 오류:`, error.message);
      }

      // 3. LOD_DB 기반 거래 정리 (어제 날짜 기준)
      try {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const sinceDate = yesterday.toISOString().split('T')[0];
        const result = tradeService.cleanupTrades(sinceDate);
        console.log(`[DbCleanup] LOD 검증: ${result.removed}개 제거, ${result.kept}개 유지`);
      } catch (error) {
        console.error(`[DbCleanup] LOD 검증 오류:`, error.message);
      }

      console.log(`[DbCleanup] 일일 정리 완료`);

      // 오래된 키 정리
      if (checked.size > 60) checked.clear();
    }
  }, 60 * 1000);

  console.log(`[DbCleanup] 매일 04:00 자동 정리 스케줄 등록 (거래 14일, 파티 7일)`);
}

app.listen(PORT, () => {
  console.log(`KakaoTalk Bot server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  startNoticeScheduler();
  startDbCleanupScheduler();
  // 위키 캐시 프리로드 (서버 시작 시 미리 로드)
  preloadWikiCache().catch(e => console.error('Wiki preload error:', e));
});

// 프로세스 종료 시 DB 저장
function gracefulShutdown(signal) {
  console.log(`[${signal}] Saving databases...`);
  try {
    nicknameService.close();
    console.log(`[${signal}] nickname.db saved`);
  } catch (e) { console.error(`[${signal}] nickname.db save failed:`, e.message); }
  try {
    noticeService.close();
    console.log(`[${signal}] notice.db saved`);
  } catch (e) { console.error(`[${signal}] notice.db save failed:`, e.message); }
  try {
    tradeService.close();
    console.log(`[${signal}] trade.db saved`);
  } catch (e) { console.error(`[${signal}] trade.db save failed:`, e.message); }
  try {
    partyService.close();
    console.log(`[${signal}] party.db saved`);
  } catch (e) { console.error(`[${signal}] party.db save failed:`, e.message); }
  console.log(`[${signal}] Shutdown complete`);
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));