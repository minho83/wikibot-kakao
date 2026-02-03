const express = require('express');
const { MessageParser } = require('../utils/messageParser');
const { SearchService } = require('../services/searchService');
const { ResponseFormatter } = require('../utils/responseFormatter');

const router = express.Router();
const messageParser = new MessageParser();
const searchService = new SearchService();
const responseFormatter = new ResponseFormatter();

// 서버 시작 시 검색 인덱스 초기화
let initialized = false;
const initializeService = async () => {
  if (!initialized) {
    await searchService.initialize();
    initialized = true;
  }
};
initializeService().catch(console.error);

router.post('/kakao', async (req, res) => {
  try {
    // 초기화 대기
    if (!initialized) {
      await initializeService();
    }

    const { message, user_id, room_id } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: message'
      });
    }

    const parsedMessage = messageParser.parse(message);

    if (!parsedMessage.isCommand) {
      return res.json({
        success: true,
        message: '명령어는 !로 시작해야 합니다. (!도움말 입력시 사용법 확인)',
        response_type: 'text'
      });
    }

    let result;

    switch (parsedMessage.command) {
      case '!검색':
        if (!parsedMessage.query) {
          result = { success: false, message: '검색어를 입력해주세요.\n예: !검색 메테오' };
        } else {
          result = searchService.search(parsedMessage.query);
        }
        break;
      case '!통계':
        result = searchService.getStats();
        break;
      case '!도움말':
        result = responseFormatter.getHelpMessage();
        break;
      default:
        result = {
          success: false,
          message: `알 수 없는 명령어: ${parsedMessage.command}\n!도움말을 입력하여 사용법을 확인하세요.`
        };
    }

    const formattedResponse = responseFormatter.format(result);

    res.json({
      success: true,
      message: formattedResponse.message,
      response_type: formattedResponse.type || 'text'
    });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      success: false,
      message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
