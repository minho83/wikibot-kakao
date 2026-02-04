import json
import logging
import os
import subprocess
import time
from datetime import datetime

import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Iris (redroid) reply 엔드포인트
IRIS_URL = os.getenv('IRIS_URL', 'http://192.168.0.80:3000')
# wikibot-kakao 서버 주소
WIKIBOT_URL = os.getenv('WIKIBOT_URL', 'http://localhost:8100')
# 배포 스크립트 경로
DEPLOY_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy.sh")

# 요청 딜레이 관리
last_request_time = 0
REQUEST_DELAY = 2


# ── 유틸리티 ──────────────────────────────────────────────

def send_reply(chat_id, message):
    """Iris를 통해 채팅방에 메시지 전송"""
    try:
        payload = {"type": "text", "room": str(chat_id), "data": message}
        resp = requests.post(f"{IRIS_URL}/reply", json=payload, timeout=5)
        logger.info(f"Reply → {chat_id}: {resp.status_code}")
    except Exception as e:
        logger.error(f"Reply 전송 오류: {e}")


def ask_wikibot(endpoint, query="", max_length=500):
    """wikibot 엔드포인트 호출"""
    global last_request_time
    try:
        now = time.time()
        wait = REQUEST_DELAY - (now - last_request_time)
        if wait > 0:
            time.sleep(wait)
        last_request_time = time.time()

        resp = requests.post(
            f"{WIKIBOT_URL}{endpoint}",
            json={"query": query, "max_length": max_length},
            timeout=30,
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        logger.error(f"wikibot 통신 오류: {e}")
    return None


def format_search_result(result, sender):
    """wikibot 검색 결과를 메시지로 포맷"""
    if result is None:
        return f"{sender}님, 서버 연결에 실패했습니다."

    answer = result.get("answer", "검색 결과가 없습니다.")
    sources = result.get("sources", [])
    response = answer

    filtered = [s for s in sources if s.get("url")]
    if filtered:
        response += "\n\n📚 관련 링크:\n"
        for s in filtered[:2]:
            if s.get("url"):
                response += f"• {s.get('title', '링크')}\n  🔗 {s['url']}\n"

    return response.strip()


def multi_search(endpoint, query, sender):
    """& 구분자로 여러 검색어 동시 검색"""
    queries = [q.strip() for q in query.split("&") if q.strip()]
    if len(queries) <= 1:
        result = ask_wikibot(endpoint, query)
        return format_search_result(result, sender)

    parts = []
    for q in queries[:5]:
        result = ask_wikibot(endpoint, q, max_length=300)
        parts.append(f"【{q}】\n{format_search_result(result, sender)}")
    return "\n\n".join(parts)


# ── 닉네임/입퇴장 ────────────────────────────────────────

def check_nickname(sender_name, sender_id, room_id):
    """wikibot 닉네임 변경 체크"""
    try:
        resp = requests.post(
            f"{WIKIBOT_URL}/api/nickname/check",
            json={"sender_name": sender_name, "sender_id": sender_id, "room_id": room_id},
            timeout=5,
        )
        data = resp.json()
        if data.get("success") and data.get("notification"):
            return data["notification"]
    except Exception as e:
        logger.error(f"닉네임 체크 오류: {e}")
    return ""


def log_member_event(user_id, nickname, room_id, event_type):
    """wikibot 입퇴장 이벤트 기록"""
    try:
        resp = requests.post(
            f"{WIKIBOT_URL}/api/nickname/member-event",
            json={"user_id": user_id, "nickname": nickname, "room_id": room_id, "event_type": event_type},
            timeout=5,
        )
        data = resp.json()
        if data.get("success") and data.get("notification"):
            return data["notification"]
    except Exception as e:
        logger.error(f"입퇴장 이벤트 오류: {e}")
    return ""


# ── 관리자 명령 ───────────────────────────────────────────

def handle_admin_command(msg, sender_id, room_id=None):
    """관리자 명령 처리. 응답 메시지 반환."""

    if msg.startswith("!관리자등록"):
        try:
            resp = requests.post(
                f"{WIKIBOT_URL}/api/nickname/admin/register",
                json={"admin_id": sender_id},
                timeout=5,
            )
            return resp.json().get("message", "처리 완료")
        except Exception as e:
            logger.error(f"관리자 등록 오류: {e}")
            return "관리자 등록 중 오류가 발생했습니다."

    if msg.startswith("!닉변감지 추가"):
        parts = msg.split()
        if len(parts) < 3:
            return "사용법: !닉변감지 추가 [room_id] [room_name(선택)]"
        target_room = parts[2]
        room_name = " ".join(parts[3:]) if len(parts) > 3 else ""
        try:
            resp = requests.post(
                f"{WIKIBOT_URL}/api/nickname/admin/rooms",
                json={"admin_id": sender_id, "room_id": target_room, "room_name": room_name},
                timeout=5,
            )
            return resp.json().get("message", "처리 완료")
        except Exception as e:
            logger.error(f"채팅방 추가 오류: {e}")
            return "채팅방 추가 중 오류가 발생했습니다."

    if msg.startswith("!닉변감지 제거"):
        parts = msg.split()
        if len(parts) < 3:
            return "사용법: !닉변감지 제거 [room_id]"
        target_room = parts[2]
        try:
            resp = requests.delete(
                f"{WIKIBOT_URL}/api/nickname/admin/rooms/{target_room}",
                json={"admin_id": sender_id},
                timeout=5,
            )
            return resp.json().get("message", "처리 완료")
        except Exception as e:
            logger.error(f"채팅방 제거 오류: {e}")
            return "채팅방 제거 중 오류가 발생했습니다."

    if msg.startswith("!닉변감지 목록"):
        try:
            resp = requests.get(
                f"{WIKIBOT_URL}/api/nickname/admin/rooms",
                params={"admin_id": sender_id},
                timeout=5,
            )
            data = resp.json()
            if not data.get("success"):
                return data.get("message", "조회 실패")
            rooms = data.get("rooms", [])
            if not rooms:
                return "감시 중인 채팅방이 없습니다."
            lines = ["[감시 채팅방 목록]"]
            for r in rooms:
                status = "활성" if r.get("enabled") else "비활성"
                name = r.get("room_name") or r.get("room_id")
                lines.append(f"- {name} ({r.get('room_id')}) [{status}]")
            return "\n".join(lines)
        except Exception as e:
            logger.error(f"채팅방 목록 오류: {e}")
            return "채팅방 목록 조회 중 오류가 발생했습니다."

    if msg.startswith("!닉변이력"):
        parts = msg.split()
        if len(parts) < 2:
            return "사용법: !닉변이력 [room_id]"
        target_room = parts[1]
        try:
            resp = requests.get(
                f"{WIKIBOT_URL}/api/nickname/history/{target_room}",
                params={"admin_id": sender_id},
                timeout=5,
            )
            data = resp.json()
            if not data.get("success"):
                return data.get("message", "조회 실패")
            history = data.get("history", [])
            if not history:
                return "닉네임 변경 이력이 없습니다."
            lines = [f"[닉네임 이력 - {target_room}]"]
            for h in history[:30]:
                lines.append(f"- [{h.get('detected_at')}] {h.get('sender_name')}")
            if len(history) > 30:
                lines.append(f"... 외 {len(history) - 30}건")
            return "\n".join(lines)
        except Exception as e:
            logger.error(f"이력 조회 오류: {e}")
            return "이력 조회 중 오류가 발생했습니다."

    if msg.startswith("!서버재시작"):
        try:
            resp = requests.post(
                f"{WIKIBOT_URL}/api/nickname/admin/verify",
                json={"admin_id": sender_id, "room_id": room_id},
                timeout=5,
            )
            data = resp.json()
            if not data.get("success"):
                return data.get("message", "권한이 없습니다.")
        except Exception:
            return "권한 확인 중 오류가 발생했습니다."

        try:
            subprocess.Popen(
                ["bash", DEPLOY_SCRIPT],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            logger.info(f"서버 재시작 실행 (by {sender_id})")
            return "서버 재시작을 시작합니다. (git pull → 빌드 → 재시작)"
        except Exception as e:
            logger.error(f"서버 재시작 오류: {e}")
            return f"서버 재시작 실패: {e}"

    return None


# ── 시스템 메시지 처리 ────────────────────────────────────

def handle_system_message(data, chat_id):
    """type 0 시스템 메시지 처리 (입퇴장)"""
    try:
        msg_text = data.get('msg', '')
        json_info = data.get('json', {})
        user_id = str(json_info.get('user_id', ''))

        feed = json.loads(msg_text)
        feed_type = feed.get('feedType')
        member = feed.get('member', {})
        nickname = member.get('nickName', '')
        member_user_id = str(member.get('userId', user_id))

        if feed_type == 1:
            event_type = 'join'
        elif feed_type == 2:
            event_type = 'leave'
        else:
            return

        notification = log_member_event(member_user_id, nickname, chat_id, event_type)
        if notification:
            send_reply(chat_id, notification)

    except (json.JSONDecodeError, KeyError):
        pass
    except Exception as e:
        logger.error(f"시스템 메시지 처리 오류: {e}")


# ── 웹훅 엔드포인트 ──────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy"})


@app.route('/webhook', methods=['POST'])
def webhook():
    try:
        data = request.get_json(silent=True) or {}
        logger.info(f"받은 데이터: {data}")

        msg = data.get('msg', '')
        room = data.get('room', '')
        sender = data.get('sender', '')
        is_group = data.get('isGroupChat', True)
        json_info = data.get('json', {})
        msg_type = str(json_info.get('type', '1'))
        chat_id = str(json_info.get('chat_id', room))
        user_id = str(json_info.get('user_id', ''))

        # ── 시스템 메시지 (입퇴장) ──
        if msg_type == '0':
            handle_system_message(data, chat_id)
            return jsonify({"status": "ok"})

        # sender 없으면 무시
        if not sender:
            return jsonify({"status": "ok"})

        # 봇 자신의 메시지 무시
        if sender == 'Iris':
            return jsonify({"status": "ok"})

        logger.info(f"[{room}] {sender}: {msg}")

        # ── 닉네임 변경 체크 (모든 메시지) ──
        if user_id and chat_id:
            notification = check_nickname(sender, user_id, chat_id)
            if notification:
                send_reply(chat_id, notification)

        # ── 명령어 처리 ──
        msg_stripped = msg.strip()
        response_msg = None

        # 방 확인
        if msg_stripped == "!방확인":
            response_msg = f"[방 정보]\nroom: {room}\nchat_id: {chat_id}\nsender: {sender}\nuser_id: {user_id}"

        # 관리자 명령 (DM 또는 그룹)
        elif msg_stripped.startswith("!관리자등록") or msg_stripped.startswith("!닉변감지") or msg_stripped.startswith("!닉변이력"):
            result = handle_admin_command(msg_stripped, user_id, room_id=chat_id)
            if result:
                response_msg = result

        # 서버 재시작
        elif msg_stripped.startswith("!서버재시작"):
            result = handle_admin_command(msg_stripped, user_id, room_id=chat_id)
            if result:
                response_msg = result

        # 아이템 검색
        elif msg_stripped.startswith("!아이템"):
            query = msg_stripped[4:].strip()
            if query:
                response_msg = multi_search("/ask/item", query, sender)
            else:
                response_msg = "검색어를 입력해주세요. 예: !아이템 오리하르콘"

        # 스킬/마법 검색
        elif msg_stripped.startswith("!스킬") or msg_stripped.startswith("!마법"):
            query = msg_stripped[3:].strip()
            if query:
                response_msg = multi_search("/ask/skill", query, sender)
            else:
                response_msg = "검색어를 입력해주세요. 예: !스킬 메테오"

        # 게시판 검색
        elif msg_stripped.startswith("!게시판"):
            query = msg_stripped[4:].strip()
            if query:
                result = ask_wikibot("/ask/community", query)
                response_msg = format_search_result(result, sender)
            else:
                response_msg = "검색어를 입력해주세요. 예: !게시판 발록"

        # 공지사항
        elif msg_stripped.startswith("!공지"):
            query = msg_stripped[3:].strip()
            result = ask_wikibot("/ask/notice", query)
            response_msg = format_search_result(result, sender)

        # 업데이트
        elif msg_stripped.startswith("!업데이트"):
            query = msg_stripped[5:].strip()
            result = ask_wikibot("/ask/update", query)
            response_msg = format_search_result(result, sender)

        # 통합 검색
        elif msg_stripped.startswith("!검색") or msg_stripped.startswith("!질문"):
            query = msg_stripped[3:].strip()
            if query:
                result = ask_wikibot("/ask", query)
                response_msg = format_search_result(result, sender)
            else:
                response_msg = "검색어를 입력해주세요. 예: !검색 메테오"

        # 도움말
        elif msg_stripped == "!도움말" or msg_stripped == "도움말":
            response_msg = """📋 명령어 안내
!아이템 [이름] - 아이템 검색
!스킬 [이름] - 스킬/마법 검색
!게시판 [키워드] - 게시판 검색
!검색 [키워드] - 통합 검색
!공지 [날짜] - 공지사항 (예: !공지 2/5)
!업데이트 [날짜] - 업데이트 내역

💡 &로 여러 개 동시 검색 가능
예: !아이템 오리하르콘 & 미스릴"""

        # 응답 전송
        if response_msg:
            send_reply(chat_id, response_msg)

        return jsonify({"status": "ok"})

    except Exception as e:
        logger.error(f"Webhook error: {e}")
        return jsonify({"status": "error"}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
