"""
네이버 카페 크롤러 (성천직자의 어둠의전설)
Playwright async + 쿠키 세션 기반 headless 크롤링
"""

import json
import os
import re
import random
import asyncio
from datetime import datetime

from playwright.async_api import async_playwright, BrowserContext
from loguru import logger
from dotenv import load_dotenv

from utils.image_handler import ImageHandler

load_dotenv(override=True)

DATA_PATH = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
COOKIES_PATH = os.getenv("NAVER_COOKIES_PATH", "./naver_cookies.json")
DELAY_MIN = float(os.getenv("NAVER_DELAY_MIN", "3"))
DELAY_MAX = float(os.getenv("NAVER_DELAY_MAX", "5"))

CAFE_ID = "13434008"
BASE_URL = "https://cafe.naver.com/f-e"

NAVER_IMAGE_HEADERS = {
    "Referer": "https://cafe.naver.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

BOARDS = [
    {"menu_id": 12,  "name": "팁과 정보"},
    {"menu_id": 11,  "name": "퀘스트 공략"},
    {"menu_id": 131, "name": "아이템 정보"},
    {"menu_id": 132, "name": "스킬 정보"},
]


class CookieExpiredException(Exception):
    """네이버 쿠키 만료 예외"""
    pass


class NaverCafeCrawler:
    def __init__(self):
        os.makedirs(DATA_PATH, exist_ok=True)
        self._playwright = None
        self._browser = None

    async def _delay(self):
        """요청 간 랜덤 딜레이"""
        await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

    async def load_session(self) -> BrowserContext:
        """
        naver_cookies.json 로드 → headless Playwright context 생성
        로그인 확인 후 context 반환
        """
        if not os.path.exists(COOKIES_PATH):
            raise FileNotFoundError(
                f"쿠키 파일 없음: {COOKIES_PATH}\n"
                "로컬 PC에서 save_cookies_local.py 실행 후 업로드하세요."
            )

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=True)

        context = await self._browser.new_context(storage_state=COOKIES_PATH)

        # 로그인 상태 확인: 실제 카페 게시판 접근 가능 여부로 검증
        page = await context.new_page()
        test_url = f"{BASE_URL}/cafes/{CAFE_ID}/menus/{BOARDS[0]['menu_id']}?page=1"
        await page.goto(test_url, wait_until="domcontentloaded", timeout=15000)
        await asyncio.sleep(3)

        # 게시글 링크가 있으면 로그인 성공
        articles = await page.query_selector_all("a.article")
        await page.close()

        if not articles:
            await self._cleanup()
            raise CookieExpiredException("네이버 쿠키가 만료되었습니다.")

        logger.info("네이버 로그인 확인 완료")
        return context

    async def _cleanup(self):
        """브라우저/Playwright 정리"""
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

    async def _extract_and_download_images(self, page, article_id: str) -> list[dict]:
        """게시글 페이지에서 이미지 추출 + 다운로드"""
        try:
            # DOM에서 이미지 정보 일괄 추출
            image_data = await page.evaluate("""
                () => {
                    const selectors = [
                        '.se-image img',
                        '.se-module-image img',
                        '.se-viewer img',
                        '#postViewArea img'
                    ];
                    const seen = new Set();
                    const results = [];
                    for (const sel of selectors) {
                        for (const img of document.querySelectorAll(sel)) {
                            const src = img.src || img.dataset.lazySrc || img.dataset.src || '';
                            if (!src || seen.has(src)) continue;
                            seen.add(src);
                            results.push({
                                url: src,
                                alt: img.alt || '',
                                width: img.naturalWidth || img.width || 0,
                                height: img.naturalHeight || img.height || 0
                            });
                        }
                    }
                    return results;
                }
            """)

            if not image_data:
                return []

            # 필터링
            candidates = ImageHandler.filter_image_candidates(image_data)
            if not candidates:
                return []

            # 저장 디렉토리
            save_dir = os.path.join(DATA_PATH, "images", article_id)

            downloaded = []
            for idx, img in enumerate(candidates, 1):
                url = img["url"]
                # 확장자 추출
                ext = url.split("?")[0].split(".")[-1].lower()
                if ext not in ("jpg", "jpeg", "png", "gif", "webp"):
                    ext = "jpg"
                filename = f"img_{idx:03d}.{ext}"

                # 1차: httpx 다운로드
                result = await ImageHandler.download_image_httpx(
                    url, save_dir, filename,
                    headers=NAVER_IMAGE_HEADERS
                )

                # 2차: Playwright 폴백 (403 등)
                if not result:
                    result = await ImageHandler.download_image_playwright(
                        page, url, save_dir, filename
                    )

                if result:
                    downloaded.append(result)

            if downloaded:
                logger.info(f"게시글 {article_id}: 이미지 {len(downloaded)}장 다운로드")

            return downloaded

        except Exception as e:
            logger.warning(f"게시글 {article_id} 이미지 추출 실패: {e}")
            return []

    async def crawl_list(self, context: BrowserContext, menu_id: int, page_num: int) -> list[dict]:
        """게시글 목록 크롤링"""
        url = f"{BASE_URL}/cafes/{CAFE_ID}/menus/{menu_id}?page={page_num}"
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)

            # React SPA 렌더링 대기
            try:
                await page.wait_for_selector("a.article", timeout=10000)
            except Exception:
                logger.warning(f"게시판 {menu_id} 페이지 {page_num}: 게시글 없음")
                return []

            links = await page.query_selector_all("a.article")
            items = []

            for link in links:
                href = await link.get_attribute("href") or ""
                # /articles/{article_id} 형태에서 ID 추출
                match = re.search(r"/articles/(\d+)", href)
                if not match:
                    continue

                article_id = match.group(1)
                title_el = await link.query_selector(".article_title, .inner_list .title")
                title = ""
                if title_el:
                    title = (await title_el.inner_text()).strip()
                if not title:
                    title = (await link.inner_text()).strip()

                items.append({
                    "article_id": article_id,
                    "title": title,
                    "menu_id": menu_id
                })

            logger.info(f"게시판 {menu_id} 페이지 {page_num}: {len(items)}건 발견")
            return items

        except Exception as e:
            logger.error(f"게시판 {menu_id} 페이지 {page_num} 크롤링 실패: {e}")
            return []
        finally:
            await page.close()

    async def crawl_post(
        self, context: BrowserContext, article_id: str, menu_id: int, board_name: str
    ) -> dict | None:
        """게시글 상세 크롤링 → JSON 저장"""
        filepath = os.path.join(DATA_PATH, f"{article_id}.json")
        if os.path.exists(filepath):
            logger.debug(f"이미 존재: {article_id}")
            return None

        url = f"{BASE_URL}/cafes/{CAFE_ID}/articles/{article_id}?menuid={menu_id}"
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=30000)
            await asyncio.sleep(3)  # iframe 로딩 대기

            # 본문 프레임 찾기 (네이버 카페는 iframe 안에 본문을 로드)
            content_frame = None
            content_selectors = [
                ".ArticleContentBox", ".se-viewer", ".se-main-container",
                "#postViewArea", ".article_viewer"
            ]

            # 메인 페이지에서 먼저 찾기
            for selector in content_selectors:
                el = await page.query_selector(selector)
                if el:
                    content_frame = page
                    break

            # 메인 페이지에 없으면 iframe에서 찾기
            if not content_frame:
                for frame in page.frames[1:]:
                    for selector in content_selectors:
                        try:
                            el = await frame.query_selector(selector)
                            if el:
                                content_frame = frame
                                break
                        except Exception:
                            continue
                    if content_frame:
                        break

            if not content_frame:
                logger.warning(f"게시글 {article_id}: 본문 프레임 없음")
                return None

            # 본문 추출
            content = ""
            for selector in content_selectors:
                el = await content_frame.query_selector(selector)
                if el:
                    content = await el.inner_text()
                    break

            if not content or len(content.strip()) < 10:
                logger.warning(f"게시글 {article_id}: 본문 추출 실패")
                return None

            content = re.sub(r"\n{3,}", "\n\n", content).strip()

            # 이미지 추출 및 다운로드 (content_frame 사용)
            images = []
            if ImageHandler.is_enabled():
                images = await self._extract_and_download_images(content_frame, article_id)

            # 제목
            title = ""
            for sel in [".title_text", ".article_header .title", ".ArticleTitle"]:
                title_el = await content_frame.query_selector(sel)
                if title_el:
                    title = (await title_el.inner_text()).strip()
                    break

            # 작성자
            author = ""
            for sel in [".profile_info .nickname", ".WriterInfo .nick", ".nickname"]:
                author_el = await content_frame.query_selector(sel)
                if author_el:
                    author = (await author_el.inner_text()).strip()
                    break

            # 날짜
            date = ""
            for sel in [".article_info .date", ".WriterInfo .date", ".date"]:
                date_el = await content_frame.query_selector(sel)
                if date_el:
                    date = (await date_el.inner_text()).strip()
                    break

            # 조회수
            views = 0
            for sel in [".article_info .count", ".WriterInfo .count", ".count"]:
                views_el = await content_frame.query_selector(sel)
                if views_el:
                    views_text = await views_el.inner_text()
                    views_match = re.search(r"[\d,]+", views_text)
                    if views_match:
                        views = int(views_match.group().replace(",", ""))
                    break

            post_data = {
                "id": article_id,
                "menu_id": menu_id,
                "title": title,
                "author": author,
                "date": date,
                "views": views,
                "content": content,
                "images": [
                    {
                        "filename": img["filename"],
                        "original_url": img["original_url"],
                        "local_path": img["local_path"],
                        "size_bytes": img["size_bytes"],
                    }
                    for img in images
                ],
                "url": url,
                "source": "naver_cafe",
                "board_name": board_name,
                "crawled_at": datetime.now().isoformat(),
                "bookmark_created": False
            }

            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(post_data, f, ensure_ascii=False, indent=2)

            logger.info(f"저장 완료: {article_id} - {title}")
            return post_data

        except Exception as e:
            logger.error(f"게시글 {article_id} 크롤링 실패: {e}")
            return None
        finally:
            await page.close()

    async def crawl_all_boards(self, pages_per_board: int = 10) -> dict:
        """4개 게시판 전체 크롤링"""
        total_new = 0
        total_skipped = 0

        context = await self.load_session()

        try:
            for board in BOARDS:
                menu_id = board["menu_id"]
                board_name = board["name"]
                logger.info(f"--- 게시판: {board_name} (menu_id={menu_id}) ---")

                for page_num in range(1, pages_per_board + 1):
                    items = await self.crawl_list(context, menu_id, page_num)
                    if not items:
                        break

                    for item in items:
                        await self._delay()
                        result = await self.crawl_post(
                            context,
                            article_id=item["article_id"],
                            menu_id=menu_id,
                            board_name=board_name
                        )
                        if result:
                            total_new += 1
                        else:
                            total_skipped += 1

                    await self._delay()

        finally:
            await self._cleanup()

        stats = {"new": total_new, "skipped": total_skipped}
        logger.info(f"카페 크롤링 완료: 신규 {total_new}건, 스킵 {total_skipped}건")
        return stats

    async def crawl_new(self) -> dict:
        """
        각 게시판 신규 게시글만 크롤링 (스케줄러용).
        이미 크롤링된 게시글을 만나면 해당 게시판 크롤링 중단 → 불필요한 요청 최소화.
        """
        total_new = 0
        total_skipped = 0

        context = await self.load_session()

        try:
            for board in BOARDS:
                items = await self.crawl_list(context, board["menu_id"], 1)
                for item in items:
                    # 이미 크롤링된 게시글이면 이후 게시글도 이미 있으므로 중단
                    filepath = os.path.join(DATA_PATH, f"{item['article_id']}.json")
                    if os.path.exists(filepath):
                        logger.debug(f"기존 게시글 도달: {item['article_id']} → 게시판 크롤링 중단")
                        total_skipped += 1
                        break

                    await self._delay()
                    result = await self.crawl_post(
                        context,
                        article_id=item["article_id"],
                        menu_id=board["menu_id"],
                        board_name=board["name"]
                    )
                    if result:
                        total_new += 1
                    else:
                        total_skipped += 1

        finally:
            await self._cleanup()

        stats = {"new": total_new, "skipped": total_skipped}
        logger.info(f"카페 신규 크롤링 완료: 신규 {total_new}건, 스킵 {total_skipped}건")
        return stats
