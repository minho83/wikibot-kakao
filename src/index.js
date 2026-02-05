const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
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
          if (item.needLevel) answer += `   습득레벨: ${item.needLevel}`;
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
          if (item.needLevel) answer += `   습득레벨: ${item.needLevel}`;
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
        if (item.needLevel) answer += `   습득레벨: ${item.needLevel}`;
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
      return res.status(400).json({ answer: '검색어를 입력해주세요.', sources: [] });
    }

    // Rate limiting 체크
    const rateCheck = canMakeCommunityRequest();
    if (!rateCheck.allowed) {
      const waitSec = Math.ceil(rateCheck.waitTime / 1000);
      return res.json({
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

      res.json({ answer, sources });
    } else {
      res.json({ answer: result.message, sources: [] });
    }
  } catch (error) {
    console.error('Community search error:', error);
    res.status(500).json({ answer: '게시판 검색 중 오류가 발생했습니다.', sources: [] });
  }
});

// 공지사항 조회 (/ask/notice) - Rate limiting 적용
app.post('/ask/notice', async (req, res) => {
  try {
    const rateCheck = canMakeCommunityRequest();
    if (!rateCheck.allowed) {
      const waitSec = Math.ceil(rateCheck.waitTime / 1000);
      return res.json({
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

      res.json({ answer, sources: [{ title: data.title, url: data.link, score: 1 }] });
    } else {
      res.json({ answer: result.message, sources: [] });
    }
  } catch (error) {
    console.error('Notice error:', error);
    res.status(500).json({ answer: '공지사항 조회 중 오류가 발생했습니다.', sources: [] });
  }
});

// 업데이트 내역 조회 (/ask/update)
app.post('/ask/update', async (req, res) => {
  try {
    const rateCheck = canMakeCommunityRequest();
    if (!rateCheck.allowed) {
      const waitSec = Math.ceil(rateCheck.waitTime / 1000);
      return res.json({
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

      res.json({ answer, sources: [{ title: data.title, url: data.link, score: 1 }] });
    } else {
      res.json({ answer: result.message, sources: [] });
    }
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ answer: '업데이트 조회 중 오류가 발생했습니다.', sources: [] });
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

// 파티 메시지 수집
app.post('/api/party/collect', async (req, res) => {
  try {
    if (!initialized) await initializeService();
    const { message, sender_name, room_id } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message required' });

    const senderInfo = { name: sender_name };
    const parties = partyService.collectMessage(message, senderInfo, room_id);

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
    const { days_to_keep } = req.body || {};
    const result = partyService.cleanupOldParties(days_to_keep || 7);
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
      stats['trade.db'].records = tradeStats.totalTrades || 0;
    } catch (e) { stats['trade.db'].records = 0; }

    try {
      const partyStats = partyService.getStats();
      stats['party.db'].records = partyStats.totalParties || 0;
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
        const partyResult = partyService.cleanupOldParties(7);
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