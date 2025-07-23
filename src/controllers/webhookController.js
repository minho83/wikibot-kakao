const express = require('express');
const { MessageParser } = require('../utils/messageParser');
const { WikiService } = require('../services/wikiService');
const { ResponseFormatter } = require('../utils/responseFormatter');

const router = express.Router();
const messageParser = new MessageParser();
const wikiService = new WikiService();
const responseFormatter = new ResponseFormatter();

router.post('/kakao', async (req, res) => {
  try {
    const { message, user_id, room_id } = req.body;
    
    if (!message || !user_id || !room_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: message, user_id, room_id'
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
        result = await wikiService.search(parsedMessage.query, user_id, room_id);
        break;
      case '!질문':
        result = await wikiService.question(parsedMessage.query, user_id, room_id);
        break;
      case '!확률':
        result = await wikiService.getProbability(parsedMessage.query, user_id, room_id);
        break;
      case '!통계':
        result = await wikiService.getStats();
        break;
      case '!연결테스트':
        result = await wikiService.healthCheck();
        break;
      case '!캐시클리어':
        result = await wikiService.clearCache();
        break;
      case '!도움말':
        result = responseFormatter.getHelpMessage();
        break;
      default:
        result = {
          success: false,
          message: `알 수 없는 명령어: ${parsedMessage.command}\\n!도움말을 입력하여 사용법을 확인하세요.`
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