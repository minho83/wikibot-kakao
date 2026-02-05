const express = require('express');
const router = express.Router();

// NicknameService는 index.js에서 주입받음
let nicknameService = null;

function setNicknameService(service) {
  nicknameService = service;
}

// POST /api/nickname/check - 닉네임 변경 체크 (매 메시지마다 호출)
router.post('/check', (req, res) => {
  try {
    const { sender_name, sender_id, room_id } = req.body;

    if (!sender_name || !sender_id || !room_id) {
      return res.status(400).json({
        success: false,
        message: 'sender_name, sender_id, room_id는 필수입니다.'
      });
    }

    const notification = nicknameService.checkNickname(sender_name, sender_id, room_id);

    res.json({
      success: true,
      notification: notification
    });
  } catch (error) {
    console.error('Nickname check error:', error);
    res.status(500).json({ success: false, message: '닉네임 체크 중 오류가 발생했습니다.' });
  }
});

// POST /api/nickname/member-event - 입퇴장 이벤트 기록
router.post('/member-event', (req, res) => {
  try {
    const { user_id, nickname, room_id, event_type } = req.body;

    if (!user_id || !nickname || !room_id || !event_type) {
      return res.status(400).json({
        success: false,
        message: 'user_id, nickname, room_id, event_type는 필수입니다.'
      });
    }

    const notification = nicknameService.logMemberEvent(room_id, user_id, nickname, event_type);

    res.json({
      success: true,
      notification: notification
    });
  } catch (error) {
    console.error('Member event error:', error);
    res.status(500).json({ success: false, message: '입퇴장 이벤트 처리 중 오류가 발생했습니다.' });
  }
});

// POST /api/nickname/admin/rooms - 감시 채팅방 추가
router.post('/admin/rooms', (req, res) => {
  try {
    const { admin_id, room_id, room_name } = req.body;

    if (!admin_id || !room_id) {
      return res.status(400).json({
        success: false,
        message: 'admin_id, room_id는 필수입니다.'
      });
    }

    if (!nicknameService.isAdmin(admin_id)) {
      return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
    }

    const result = nicknameService.addRoom(room_id, room_name);

    res.json({
      success: result,
      message: result ? `채팅방 "${room_name || room_id}" 감시가 추가되었습니다.` : '채팅방 추가에 실패했습니다.'
    });
  } catch (error) {
    console.error('Add room error:', error);
    res.status(500).json({ success: false, message: '채팅방 추가 중 오류가 발생했습니다.' });
  }
});

// DELETE /api/nickname/admin/rooms/:roomId - 감시 채팅방 제거
router.delete('/admin/rooms/:roomId', (req, res) => {
  try {
    const { admin_id } = req.body;
    const roomId = req.params.roomId;

    if (!admin_id) {
      return res.status(400).json({ success: false, message: 'admin_id는 필수입니다.' });
    }

    if (!nicknameService.isAdmin(admin_id)) {
      return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
    }

    const result = nicknameService.removeRoom(roomId);

    res.json({
      success: result,
      message: result ? `채팅방 "${roomId}" 감시가 제거되었습니다.` : '채팅방 제거에 실패했습니다.'
    });
  } catch (error) {
    console.error('Remove room error:', error);
    res.status(500).json({ success: false, message: '채팅방 제거 중 오류가 발생했습니다.' });
  }
});

// GET /api/nickname/admin/rooms - 감시 채팅방 목록
router.get('/admin/rooms', (req, res) => {
  try {
    const admin_id = req.query.admin_id;

    if (!admin_id) {
      return res.status(400).json({ success: false, message: 'admin_id는 필수입니다.' });
    }

    if (!nicknameService.isAdmin(admin_id)) {
      return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
    }

    const rooms = nicknameService.listRooms();

    res.json({
      success: true,
      rooms: rooms
    });
  } catch (error) {
    console.error('List rooms error:', error);
    res.status(500).json({ success: false, message: '채팅방 목록 조회 중 오류가 발생했습니다.' });
  }
});

// GET /api/nickname/history/:roomId - 특정 방 닉네임 이력
router.get('/history/:roomId', (req, res) => {
  try {
    const admin_id = req.query.admin_id;
    const roomId = req.params.roomId;

    if (!admin_id) {
      return res.status(400).json({ success: false, message: 'admin_id는 필수입니다.' });
    }

    if (!nicknameService.isAdmin(admin_id)) {
      return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
    }

    const history = nicknameService.getNicknameHistory(roomId);

    res.json({
      success: true,
      room_id: roomId,
      history: history
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, message: '이력 조회 중 오류가 발생했습니다.' });
  }
});

// POST /api/nickname/admin/verify - 관리자 + 등록된 채팅방 동시 확인
router.post('/admin/verify', (req, res) => {
  try {
    const { admin_id, room_id } = req.body;

    if (!admin_id) {
      return res.status(400).json({ success: false, message: 'admin_id는 필수입니다.' });
    }

    const isAdmin = nicknameService.isAdmin(admin_id);
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
    }

    // room_id가 있으면 등록된 채팅방인지도 확인
    if (room_id) {
      const rooms = nicknameService.listRooms();
      const isRegistered = rooms.some(r => r.room_id === room_id && r.enabled);
      if (!isRegistered) {
        return res.status(403).json({ success: false, message: '등록되지 않은 채팅방입니다.' });
      }
    }

    res.json({ success: true, message: '권한 확인 완료' });
  } catch (error) {
    console.error('Admin verify error:', error);
    res.status(500).json({ success: false, message: '권한 확인 중 오류가 발생했습니다.' });
  }
});

// POST /api/nickname/admin/register - 관리자 등록 (최초 1회)
router.post('/admin/register', (req, res) => {
  try {
    const { admin_id } = req.body;

    if (!admin_id) {
      return res.status(400).json({ success: false, message: 'admin_id는 필수입니다.' });
    }

    const result = nicknameService.addAdmin(admin_id);

    res.json(result);
  } catch (error) {
    console.error('Admin register error:', error);
    res.status(500).json({ success: false, message: '관리자 등록 중 오류가 발생했습니다.' });
  }
});

// GET /api/nickname/admins - 관리자 목록 및 관리자 방 목록 (서버 시작 알림용)
router.get('/admins', (req, res) => {
  try {
    const info = nicknameService.getAdminsInfo();

    res.json({
      success: true,
      admins: info.admins,
      admin_rooms: info.admin_rooms
    });
  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({ success: false, message: '관리자 정보 조회 중 오류가 발생했습니다.' });
  }
});

module.exports = { router, setNicknameService };
