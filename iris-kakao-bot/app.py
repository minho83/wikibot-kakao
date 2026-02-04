import logging
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# wikibot-kakao 서버 주소
WIKIBOT_URL = "http://localhost:3000"
# IRIS reply 엔드포인트 (IRIS 서버 주소에 맞게 수정)
IRIS_REPLY_URL = "http://localhost:8080/reply"


def check_nickname(sender_name, sender_id, room_id):
    """wikibot-kakao의 닉네임 체크 API 호출"""
    try:
        resp = requests.post(
            f"{WIKIBOT_URL}/api/nickname/check",
            json={
                "sender_name": sender_name,
                "sender_id": sender_id,
                "room_id": room_id,
            },
            timeout=5,
        )
        data = resp.json()
        if data.get("success") and data.get("notification"):
            return data["notification"]
    except Exception as e:
        logger.error(f"닉네임 체크 오류: {e}")
    return ""


def send_reply(room_id, message):
    """IRIS /reply 엔드포인트로 채팅방에 메시지 전송"""
    try:
        requests.post(
            IRIS_REPLY_URL,
            json={"room_id": room_id, "message": message},
            timeout=5,
        )
    except Exception as e:
        logger.error(f"IRIS reply 전송 오류: {e}")


def handle_admin_command(msg, sender_id):
    """1:1 DM에서 관리자 명령 처리. 응답 메시지를 반환한다."""
    if msg.startswith("!관리자등록"):
        try:
            resp = requests.post(
                f"{WIKIBOT_URL}/api/nickname/admin/register",
                json={"admin_id": sender_id},
                timeout=5,
            )
            data = resp.json()
            return data.get("message", "처리 완료")
        except Exception as e:
            logger.error(f"관리자 등록 오류: {e}")
            return "관리자 등록 중 오류가 발생했습니다."

    if msg.startswith("!닉변감지 추가"):
        parts = msg.split()
        if len(parts) < 3:
            return "사용법: !닉변감지 추가 [room_id] [room_name(선택)]"
        room_id = parts[2]
        room_name = parts[3] if len(parts) > 3 else ""
        try:
            resp = requests.post(
                f"{WIKIBOT_URL}/api/nickname/admin/rooms",
                json={
                    "admin_id": sender_id,
                    "room_id": room_id,
                    "room_name": room_name,
                },
                timeout=5,
            )
            data = resp.json()
            return data.get("message", "처리 완료")
        except Exception as e:
            logger.error(f"채팅방 추가 오류: {e}")
            return "채팅방 추가 중 오류가 발생했습니다."

    if msg.startswith("!닉변감지 제거"):
        parts = msg.split()
        if len(parts) < 3:
            return "사용법: !닉변감지 제거 [room_id]"
        room_id = parts[2]
        try:
            resp = requests.delete(
                f"{WIKIBOT_URL}/api/nickname/admin/rooms/{room_id}",
                json={"admin_id": sender_id},
                timeout=5,
            )
            data = resp.json()
            return data.get("message", "처리 완료")
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
            logger.error(f"채팅방 목록 조회 오류: {e}")
            return "채팅방 목록 조회 중 오류가 발생했습니다."

    if msg.startswith("!닉변이력"):
        parts = msg.split()
        if len(parts) < 2:
            return "사용법: !닉변이력 [room_id]"
        room_id = parts[1]
        try:
            resp = requests.get(
                f"{WIKIBOT_URL}/api/nickname/history/{room_id}",
                params={"admin_id": sender_id},
                timeout=5,
            )
            data = resp.json()
            if not data.get("success"):
                return data.get("message", "조회 실패")
            history = data.get("history", [])
            if not history:
                return "닉네임 변경 이력이 없습니다."
            lines = [f"[닉네임 이력 - {room_id}]"]
            for h in history[:30]:
                lines.append(
                    f"- [{h.get('detected_at')}] {h.get('sender_name')} (ID: {h.get('sender_id')})"
                )
            if len(history) > 30:
                lines.append(f"... 외 {len(history) - 30}건")
            return "\n".join(lines)
        except Exception as e:
            logger.error(f"이력 조회 오류: {e}")
            return "이력 조회 중 오류가 발생했습니다."

    return None


@app.route("/webhook", methods=["POST"])
def webhook():
    """IRIS로부터 메시지를 수신하는 웹훅"""
    json_data = request.get_json(silent=True) or {}
    logger.info(f"받은 데이터: {json_data}")

    sender = json_data.get("sender", "")
    sender_id = json_data.get("sender_id", "")
    room = json_data.get("room", "")
    msg = json_data.get("msg", "")
    is_group = json_data.get("isGroupChat", False)

    # 1:1 DM 판별: 그룹챗이 아니거나, room == sender인 경우
    is_dm = not is_group or (room == sender)

    # 1:1 DM에서 관리자 명령 처리
    if is_dm and msg.startswith("!"):
        admin_commands = ["!관리자등록", "!닉변감지", "!닉변이력"]
        if any(msg.startswith(cmd) for cmd in admin_commands):
            result = handle_admin_command(msg, sender_id)
            if result:
                return jsonify({"success": True, "message": result})

    # 그룹챗에서 모든 메시지에 대해 닉네임 변경 체크
    if is_group and sender_id and room:
        notification = check_nickname(sender, sender_id, room)
        if notification:
            send_reply(room, notification)

    # 기존 메시지 처리 로직 (wikibot-kakao로 전달 등)
    # 필요에 따라 여기에 추가

    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
