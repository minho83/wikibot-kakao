"""
이미지 다운로드, 필터링, GPT Vision 연동 유틸리티
크롤러와 RAG 모듈이 공통으로 사용하는 이미지 처리 함수 모음
"""

import os
import re
import base64
import mimetypes
from pathlib import Path

import httpx
import requests
from loguru import logger
from dotenv import load_dotenv

load_dotenv()

# ─── 설정값 ───
IMAGE_ENABLED = os.getenv("IMAGE_ENABLED", "true").lower() == "true"
IMAGE_MAX_PER_POST = int(os.getenv("IMAGE_MAX_PER_POST", "10"))
IMAGE_MIN_SIZE_KB = int(os.getenv("IMAGE_MIN_SIZE_KB", "5"))
IMAGE_MAX_SIZE_MB = int(os.getenv("IMAGE_MAX_SIZE_MB", "10"))
IMAGE_ALLOWED_FORMATS = os.getenv("IMAGE_ALLOWED_FORMATS", "jpg,jpeg,png,gif,webp").split(",")
IMAGE_MAX_FOR_BOOKMARK = int(os.getenv("IMAGE_MAX_FOR_BOOKMARK", "5"))
IMAGE_MAX_FOR_ANSWER = int(os.getenv("IMAGE_MAX_FOR_ANSWER", "6"))
IMAGE_VISION_DETAIL_BOOKMARK = os.getenv("IMAGE_VISION_DETAIL_BOOKMARK", "low")
IMAGE_VISION_DETAIL_ANSWER = os.getenv("IMAGE_VISION_DETAIL_ANSWER", "auto")
IMAGE_DOWNLOAD_TIMEOUT = int(os.getenv("IMAGE_DOWNLOAD_TIMEOUT", "15"))

# 이모티콘/아이콘 등 제외 패턴
EXCLUDE_URL_PATTERNS = re.compile(
    r"(emoticon|sticker|button|icon|logo|badge|avatar|profile|thumbnail_small|"
    r"cafe_meta|blank\.gif|spacer|pixel|loading|spinner)",
    re.IGNORECASE
)


class ImageHandler:
    """이미지 다운로드, 필터링, GPT Vision 연동 유틸리티"""

    # 클래스 레벨 상수 (외부에서 ImageHandler.IMAGE_MAX_FOR_BOOKMARK 등으로 접근)
    IMAGE_MAX_FOR_BOOKMARK = IMAGE_MAX_FOR_BOOKMARK
    IMAGE_MAX_FOR_ANSWER = IMAGE_MAX_FOR_ANSWER
    IMAGE_VISION_DETAIL_BOOKMARK = IMAGE_VISION_DETAIL_BOOKMARK
    IMAGE_VISION_DETAIL_ANSWER = IMAGE_VISION_DETAIL_ANSWER

    @staticmethod
    def is_enabled() -> bool:
        """이미지 기능 활성화 여부"""
        return IMAGE_ENABLED

    @staticmethod
    def filter_image_candidates(images: list[dict]) -> list[dict]:
        """
        이미지 후보 필터링.
        입력: [{"url": str, "alt": str, "width": int, "height": int}, ...]
        반환: 필터링된 이미지 목록 (최대 IMAGE_MAX_PER_POST개)
        """
        seen_urls = set()
        filtered = []

        for img in images:
            url = img.get("url", "").strip()
            if not url or url.startswith("data:"):
                continue

            # 중복 URL 제거
            if url in seen_urls:
                continue
            seen_urls.add(url)

            # 제외 패턴 체크
            if EXCLUDE_URL_PATTERNS.search(url):
                continue

            # 최소 크기 체크 (DOM에서 가져온 값)
            width = img.get("width", 0) or 0
            height = img.get("height", 0) or 0
            if width > 0 and height > 0 and (width < 50 or height < 50):
                continue

            # 확장자 체크
            ext = ImageHandler._get_extension_from_url(url)
            if ext and ext not in IMAGE_ALLOWED_FORMATS:
                continue

            filtered.append(img)

            if len(filtered) >= IMAGE_MAX_PER_POST:
                break

        return filtered

    @staticmethod
    def _get_extension_from_url(url: str) -> str:
        """URL에서 파일 확장자 추출"""
        # 쿼리스트링 제거
        path = url.split("?")[0].split("#")[0]
        ext = Path(path).suffix.lstrip(".").lower()
        # 네이버 CDN 등에서 확장자 없는 경우
        if not ext:
            return ""
        return ext

    @staticmethod
    async def download_image_httpx(
        url: str, save_dir: str, filename: str,
        headers: dict = None, timeout: int = IMAGE_DOWNLOAD_TIMEOUT
    ) -> dict | None:
        """
        httpx(async)로 이미지 다운로드.
        반환: {"filename", "original_url", "local_path", "size_bytes"} or None
        """
        os.makedirs(save_dir, exist_ok=True)
        local_path = os.path.join(save_dir, filename)

        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                resp = await client.get(
                    url,
                    headers=headers or {},
                    timeout=timeout
                )
                resp.raise_for_status()

                content_type = resp.headers.get("content-type", "")
                if not content_type.startswith("image/"):
                    logger.debug(f"이미지 아님 (content-type: {content_type}): {url}")
                    return None

                data = resp.content
                size_bytes = len(data)

                # 파일 크기 검증
                if size_bytes < IMAGE_MIN_SIZE_KB * 1024:
                    logger.debug(f"이미지 너무 작음 ({size_bytes}B): {url}")
                    return None
                if size_bytes > IMAGE_MAX_SIZE_MB * 1024 * 1024:
                    logger.debug(f"이미지 너무 큼 ({size_bytes}B): {url}")
                    return None

                # 확장자 보정 (content-type 기반)
                if not Path(filename).suffix:
                    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ".jpg"
                    filename = filename + ext
                    local_path = os.path.join(save_dir, filename)

                with open(local_path, "wb") as f:
                    f.write(data)

                return {
                    "filename": filename,
                    "original_url": url,
                    "local_path": local_path,
                    "size_bytes": size_bytes
                }

        except Exception as e:
            logger.warning(f"이미지 다운로드 실패 (httpx): {url} - {e}")
            return None

    @staticmethod
    def download_image_sync(
        url: str, save_dir: str, filename: str,
        headers: dict = None, timeout: int = IMAGE_DOWNLOAD_TIMEOUT
    ) -> dict | None:
        """
        동기 방식 이미지 다운로드 (requests 기반, LOD 크롤러용).
        반환: {"filename", "original_url", "local_path", "size_bytes"} or None
        """
        os.makedirs(save_dir, exist_ok=True)
        local_path = os.path.join(save_dir, filename)

        try:
            resp = requests.get(
                url,
                headers=headers or {},
                timeout=timeout,
                stream=True
            )
            resp.raise_for_status()

            content_type = resp.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                logger.debug(f"이미지 아님 (content-type: {content_type}): {url}")
                return None

            data = resp.content
            size_bytes = len(data)

            # 파일 크기 검증
            if size_bytes < IMAGE_MIN_SIZE_KB * 1024:
                logger.debug(f"이미지 너무 작음 ({size_bytes}B): {url}")
                return None
            if size_bytes > IMAGE_MAX_SIZE_MB * 1024 * 1024:
                logger.debug(f"이미지 너무 큼 ({size_bytes}B): {url}")
                return None

            # 확장자 보정
            if not Path(filename).suffix:
                ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ".jpg"
                filename = filename + ext
                local_path = os.path.join(save_dir, filename)

            with open(local_path, "wb") as f:
                f.write(data)

            return {
                "filename": filename,
                "original_url": url,
                "local_path": local_path,
                "size_bytes": size_bytes
            }

        except Exception as e:
            logger.warning(f"이미지 다운로드 실패 (sync): {url} - {e}")
            return None

    @staticmethod
    async def download_image_playwright(
        page, url: str, save_dir: str, filename: str
    ) -> dict | None:
        """
        Playwright page 컨텍스트로 이미지 다운로드 (인증 필요 시 폴백).
        브라우저 세션의 쿠키를 활용하여 인증된 이미지 접근.
        """
        os.makedirs(save_dir, exist_ok=True)
        local_path = os.path.join(save_dir, filename)

        try:
            # 브라우저 내 fetch → base64
            b64_data = await page.evaluate("""
                async (url) => {
                    try {
                        const resp = await fetch(url, { credentials: 'include' });
                        if (!resp.ok) return null;
                        const blob = await resp.blob();
                        return new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        });
                    } catch(e) {
                        return null;
                    }
                }
            """, url)

            if not b64_data or not b64_data.startswith("data:"):
                return None

            # data:image/jpeg;base64,/9j/4AAQ... 형태 파싱
            header, encoded = b64_data.split(",", 1)
            data = base64.b64decode(encoded)
            size_bytes = len(data)

            if size_bytes < IMAGE_MIN_SIZE_KB * 1024:
                return None
            if size_bytes > IMAGE_MAX_SIZE_MB * 1024 * 1024:
                return None

            # MIME에서 확장자 추출
            mime_match = re.search(r"data:(image/\w+)", header)
            if mime_match and not Path(filename).suffix:
                ext = mimetypes.guess_extension(mime_match.group(1)) or ".jpg"
                filename = filename + ext
                local_path = os.path.join(save_dir, filename)

            with open(local_path, "wb") as f:
                f.write(data)

            return {
                "filename": filename,
                "original_url": url,
                "local_path": local_path,
                "size_bytes": size_bytes
            }

        except Exception as e:
            logger.warning(f"이미지 다운로드 실패 (playwright): {url} - {e}")
            return None

    @staticmethod
    def load_images_as_base64(
        images: list[dict], max_count: int = IMAGE_MAX_FOR_ANSWER
    ) -> list[dict]:
        """
        로컬 이미지 파일을 base64로 변환.
        입력: [{"local_path": str, ...}, ...]
        반환: [{"base64": str, "mime_type": str, "filename": str}, ...]
        """
        results = []

        for img in images[:max_count]:
            local_path = img.get("local_path", "")
            if not local_path:
                continue

            # 상대 경로 처리
            if not os.path.isabs(local_path):
                local_path = os.path.join(os.getcwd(), local_path)

            if not os.path.exists(local_path):
                logger.debug(f"이미지 파일 없음: {local_path}")
                continue

            try:
                with open(local_path, "rb") as f:
                    data = f.read()

                mime_type = mimetypes.guess_type(local_path)[0] or "image/jpeg"
                b64 = base64.b64encode(data).decode("utf-8")

                results.append({
                    "base64": b64,
                    "mime_type": mime_type,
                    "filename": img.get("filename", os.path.basename(local_path))
                })
            except Exception as e:
                logger.warning(f"이미지 base64 변환 실패: {local_path} - {e}")

        return results

    @staticmethod
    def build_vision_messages(
        text_content: str, images_b64: list[dict],
        detail: str = "auto"
    ) -> list[dict] | str:
        """
        GPT Vision API용 content 배열 구성.
        images_b64가 비어있으면 text_content 문자열 반환 (기존 호환).
        """
        if not images_b64:
            return text_content

        content = [{"type": "text", "text": text_content}]

        for img in images_b64:
            data_uri = f"data:{img['mime_type']};base64,{img['base64']}"
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": data_uri,
                    "detail": detail
                }
            })

        return content

    @staticmethod
    def get_mime_type(filepath: str) -> str:
        """파일 확장자 기반 MIME 타입 반환"""
        return mimetypes.guess_type(filepath)[0] or "image/jpeg"
