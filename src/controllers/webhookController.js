const express = require('express');
const { MessageParser } = require('../utils/messageParser');
const { CommunityService } = require('../services/communityService');
const { NoticeService } = require('../services/noticeService');
const { ResponseFormatter } = require('../utils/responseFormatter');
const featureToggles = require('../featureToggles');

const router = express.Router();
const messageParser = new MessageParser();
const communityService = new CommunityService();
const noticeService = new NoticeService();
const responseFormatter = new ResponseFormatter();

router.post('/kakao', async (req, res) => {
  try {
    const { message, user_id, room_id } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: message'
      });
    }

    const parsedMessage = messageParser.parse(message);

    // 방 자동 등록
    if (room_id) featureToggles.trackRoom(room_id);

    if (!parsedMessage.isCommand) {
      return res.json({
        success: true,
        message: '명령어는 !로 시작해야 합니다. (!도움말 입력시 사용법 확인)',
        response_type: 'text'
      });
    }

    let result;

    // 기능 토글 체크 (!도움말 제외) — 비활성 시 무응답
    if (parsedMessage.command !== '!도움말' && !featureToggles.isEnabled(parsedMessage.command, room_id)) {
      return res.json({ success: true });
    }

    switch (parsedMessage.command) {
      case '!현자':
        if (!parsedMessage.query) {
          result = { success: false, message: '검색어를 입력해주세요.\n예: !현자 발록' };
        } else {
          try {
            const commResult = await communityService.searchAndParse(parsedMessage.query);
            if (commResult.success) {
              // Custom format for community result
              result = {
                success: true,
                message: `[${commResult.data.date}] ${commResult.data.title}\n${commResult.data.link}\n\n${commResult.data.content}`
              };
            } else {
              result = commResult;
            }
          } catch (e) {
            result = { success: false, message: '게시판 검색 중 오류가 발생했습니다.' };
          }
        }
        break;
      case '!공지':
        try {
          const noticeResult = await noticeService.getLatestNotice(parsedMessage.query);
          if (noticeResult.success) {
            const d = noticeResult.data;
            let msg = `[${d.category || '공지'}] ${d.title}\n${d.date}\n\n${d.content}\n\n${d.link}`;
            if (d.otherNotices && d.otherNotices.length > 0) {
              msg += '\n\n-- 다른 공지 --\n';
              d.otherNotices.forEach((r, idx) => {
                msg += `${idx + 1}. [${r.category || ''}] ${r.title} (${r.date})\n`;
              });
            }
            result = { success: true, message: msg };
          } else {
            result = noticeResult;
          }
        } catch (e) {
          result = { success: false, message: '공지사항 조회 중 오류가 발생했습니다.' };
        }
        break;
      case '!업데이트':
        try {
          const updateResult = await noticeService.getLatestUpdate(parsedMessage.query);
          if (updateResult.success) {
            const d = updateResult.data;
            let msg = `${d.title}\n${d.date}\n\n${d.content}\n\n${d.link}`;
            if (d.otherUpdates && d.otherUpdates.length > 0) {
              msg += '\n\n-- 다른 업데이트 --\n';
              d.otherUpdates.forEach((r, idx) => {
                msg += `${idx + 1}. ${r.title} (${r.date})\n`;
              });
            }
            result = { success: true, message: msg };
          } else {
            result = updateResult;
          }
        } catch (e) {
          result = { success: false, message: '업데이트 조회 중 오류가 발생했습니다.' };
        }
        break;
      case '!파티':
        result = {
          success: true,
          message: '📋 파티 빈자리 현황\n\n아래 링크에서 실시간 파티 빈자리를 확인하세요!\n👉 https://party.milddok.cc/\n\n* 어둠의전설 나겔파티 오픈톡 데이터 기반\n* 수집상태에 따라 오차가 있을 수 있습니다.'
        };
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
