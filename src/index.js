const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const webhookController = require('./controllers/webhookController');
const { SearchService } = require('./services/searchService');
const { CommunityService } = require('./services/communityService');
const { rateLimiter, errorHandler } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const searchService = new SearchService();
const communityService = new CommunityService();

// 검색 서비스 초기화
let initialized = false;
const initializeService = async () => {
  if (!initialized) {
    await searchService.initialize();
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
          if (item.job) answer += ` | 직업: ${item.job}`;
          if (item.ac) answer += ` | AC: ${item.ac}`;
          if (item.smallDamage || item.largeDamage) answer += ` | 데미지: ${item.smallDamage || 0}/${item.largeDamage || 0}`;
          answer += '\n';
        }

        // 마법 정보
        if (item.category === 'spell') {
          if (item.costMana) answer += `   MP소모: ${item.costMana.toLocaleString('ko-KR')}`;
          if (item.needLevel) answer += ` | 습득레벨: ${item.needLevel}`;
          if (item.needGold) answer += ` | 비용: ${formatGold(item.needGold)}G`;
          answer += '\n';
          // 스탯 요구사항 (0이 아닌 것만)
          const stats = [];
          if (item.needStr && item.needStr > 0) stats.push(`힘${item.needStr}`);
          if (item.needDex && item.needDex > 0) stats.push(`민${item.needDex}`);
          if (item.needInt && item.needInt > 0) stats.push(`지${item.needInt}`);
          if (item.needWis && item.needWis > 0) stats.push(`정${item.needWis}`);
          if (item.needCon && item.needCon > 0) stats.push(`체${item.needCon}`);
          if (stats.length > 0) answer += `   요구스탯: ${stats.join(' ')}\n`;
          if (item.needItem) answer += `   필요아이템: ${item.needItem}\n`;
        }

        // 기술 정보
        if (item.category === 'skill') {
          if (item.needLevel) answer += `   습득레벨: ${item.needLevel}`;
          if (item.needGold) answer += ` | 비용: ${formatGold(item.needGold)}G`;
          answer += '\n';
          // 스탯 요구사항 (0이 아닌 것만)
          const stats = [];
          if (item.needStr && item.needStr > 0) stats.push(`힘${item.needStr}`);
          if (item.needDex && item.needDex > 0) stats.push(`민${item.needDex}`);
          if (item.needInt && item.needInt > 0) stats.push(`지${item.needInt}`);
          if (item.needWis && item.needWis > 0) stats.push(`정${item.needWis}`);
          if (item.needCon && item.needCon > 0) stats.push(`체${item.needCon}`);
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
        if (item.job) answer += ` | 직업: ${item.job}`;
        if (item.ac) answer += ` | AC: ${item.ac}`;
        if (item.smallDamage || item.largeDamage) answer += ` | 데미지: ${item.smallDamage || 0}/${item.largeDamage || 0}`;
        answer += '\n';

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
        if (item.costMana) answer += `   MP소모: ${item.costMana.toLocaleString('ko-KR')}`;
        if (item.needLevel) answer += ` | 습득레벨: ${item.needLevel}`;
        if (item.needGold) answer += ` | 비용: ${formatGold(item.needGold)}G`;
        answer += '\n';

        // 스탯 요구사항 (0이 아닌 것만)
        const stats = [];
        if (item.needStr && item.needStr > 0) stats.push(`힘${item.needStr}`);
        if (item.needDex && item.needDex > 0) stats.push(`민${item.needDex}`);
        if (item.needInt && item.needInt > 0) stats.push(`지${item.needInt}`);
        if (item.needWis && item.needWis > 0) stats.push(`정${item.needWis}`);
        if (item.needCon && item.needCon > 0) stats.push(`체${item.needCon}`);
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

app.use('/webhook', rateLimiter, webhookController);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`KakaoTalk Bot server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});