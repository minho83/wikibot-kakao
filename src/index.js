const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const webhookController = require('./controllers/webhookController');
const { SearchService } = require('./services/searchService');
const { rateLimiter, errorHandler } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const searchService = new SearchService();

// 검색 서비스 초기화
let initialized = false;
const initializeService = async () => {
  if (!initialized) {
    await searchService.initialize();
    initialized = true;
  }
};
initializeService().catch(console.error);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
          if (item.costMana) answer += `   MP소모: ${item.costMana}`;
          if (item.needLevel) answer += ` | 습득레벨: ${item.needLevel}`;
          if (item.needGold) answer += ` | 비용: ${item.needGold}G`;
          answer += '\n';
          // 스탯 요구사항
          const stats = [];
          if (item.needStr) stats.push(`힘${item.needStr}`);
          if (item.needDex) stats.push(`민${item.needDex}`);
          if (item.needInt) stats.push(`지${item.needInt}`);
          if (item.needWis) stats.push(`정${item.needWis}`);
          if (item.needCon) stats.push(`체${item.needCon}`);
          if (stats.length > 0) answer += `   요구스탯: ${stats.join(' ')}\n`;
          if (item.needItem) answer += `   필요아이템: ${item.needItem}\n`;
        }

        // 기술 정보
        if (item.category === 'skill') {
          if (item.needLevel) answer += `   습득레벨: ${item.needLevel}`;
          if (item.needGold) answer += ` | 비용: ${item.needGold}G`;
          answer += '\n';
          const stats = [];
          if (item.needStr) stats.push(`힘${item.needStr}`);
          if (item.needDex) stats.push(`민${item.needDex}`);
          if (item.needInt) stats.push(`지${item.needInt}`);
          if (item.needWis) stats.push(`정${item.needWis}`);
          if (item.needCon) stats.push(`체${item.needCon}`);
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