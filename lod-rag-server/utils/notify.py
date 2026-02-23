"""
카카오톡 알림 유틸리티
Iris API를 통해 알림 메시지 발송
"""

import os
import httpx
from loguru import logger
from dotenv import load_dotenv

load_dotenv(override=True)

IRIS_URL = os.getenv("IRIS_URL", "http://192.168.0.80:3000")
NOTIFY_ROOM_ID = os.getenv("NOTIFY_ROOM_ID", "")


async def send_kakao_notify(message: str):
    """Iris API POST /reply로 카카오톡 알림 발송"""
    if not NOTIFY_ROOM_ID:
        logger.warning("NOTIFY_ROOM_ID 미설정, 알림 생략")
        return

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{IRIS_URL}/reply",
                json={
                    "type": "text",
                    "room": NOTIFY_ROOM_ID,
                    "data": message
                },
                timeout=10
            )
            if resp.status_code == 200:
                logger.info("카카오톡 알림 발송 완료")
            else:
                logger.warning(f"카카오톡 알림 응답 코드: {resp.status_code}")
    except Exception as e:
        logger.error(f"카카오톡 알림 발송 실패: {e}")


COOKIE_EXPIRED_MSG = """🚨 네이버 카페 쿠키가 만료되었습니다.

[로컬 PC에서 실행]
python save_cookies_local.py

[서버 업로드]
scp naver_cookies.json user@서버IP:프로젝트경로/"""


CRAWL_COMPLETE_MSG = """✅ 크롤링 완료
LOD 공홈: {lod_count}건
네이버 카페: {cafe_count}건
신규 책갈피: {bookmark_count}건 생성"""
