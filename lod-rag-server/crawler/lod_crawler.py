"""
LOD 공식 홈페이지 크롤러
현자의 마을 게시판 (SearchBoard=1) 크롤링
"""

import json
import os
import re
import random
import time
from datetime import datetime

import requests
from bs4 import BeautifulSoup
from loguru import logger
from dotenv import load_dotenv

from utils.image_handler import ImageHandler

load_dotenv(override=True)

DATA_PATH = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
DELAY_MIN = float(os.getenv("LOD_DELAY_MIN", "1"))
DELAY_MAX = float(os.getenv("LOD_DELAY_MAX", "3"))


class LodCrawler:
    BASE_URL = "https://lod.nexon.com"
    LIST_URL = "/Community/game"
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    def __init__(self):
        os.makedirs(DATA_PATH, exist_ok=True)

    def _delay(self):
        """요청 간 랜덤 딜레이"""
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

    def _extract_and_download_images(self, board_text, post_id: str) -> list[dict]:
        """BeautifulSoup board_text에서 이미지 추출 + 다운로드"""
        try:
            img_tags = board_text.find_all("img")
            if not img_tags:
                return []

            # 이미지 후보 수집
            candidates_raw = []
            for img in img_tags:
                src = img.get("src", "") or img.get("data-src", "")
                if not src:
                    continue

                # 상대경로 → 절대경로
                if src.startswith("/"):
                    src = f"{self.BASE_URL}{src}"
                elif not src.startswith("http"):
                    continue

                width = 0
                height = 0
                try:
                    width = int(img.get("width", 0) or 0)
                    height = int(img.get("height", 0) or 0)
                except (ValueError, TypeError):
                    pass

                candidates_raw.append({
                    "url": src,
                    "alt": img.get("alt", ""),
                    "width": width,
                    "height": height
                })

            # 필터링
            candidates = ImageHandler.filter_image_candidates(candidates_raw)
            if not candidates:
                return []

            # 저장 디렉토리
            save_dir = os.path.join(DATA_PATH, "images", post_id)

            downloaded = []
            for idx, img in enumerate(candidates, 1):
                url = img["url"]
                ext = url.split("?")[0].split(".")[-1].lower()
                if ext not in ("jpg", "jpeg", "png", "gif", "webp"):
                    ext = "jpg"
                filename = f"img_{idx:03d}.{ext}"

                result = ImageHandler.download_image_sync(
                    url, save_dir, filename,
                    headers=self.HEADERS
                )
                if result:
                    downloaded.append(result)

            if downloaded:
                logger.info(f"게시글 {post_id}: 이미지 {len(downloaded)}장 다운로드")

            return downloaded

        except Exception as e:
            logger.warning(f"게시글 {post_id} 이미지 추출 실패: {e}")
            return []

    def crawl_list(self, page: int) -> list[dict]:
        """
        목록 페이지에서 게시글 ID/제목/URL 추출
        """
        params = {"SearchBoard": 1, "Category2": 1, "Page": page}
        url = f"{self.BASE_URL}{self.LIST_URL}"

        try:
            resp = requests.get(url, params=params, headers=self.HEADERS, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            logger.error(f"목록 페이지 {page} 요청 실패: {e}")
            return []

        soup = BeautifulSoup(resp.text, "html.parser")
        items = []

        for a_tag in soup.select("ul.community_s1 > li > a"):
            href = a_tag.get("href", "")
            # /Community/game/7832?SearchBoard=1 형태에서 post_id 추출
            match = re.search(r"/Community/game/(\d+)", href)
            if not match:
                continue

            post_id = match.group(1)
            title = a_tag.get_text(strip=True)
            full_url = f"{self.BASE_URL}{href}" if href.startswith("/") else href

            items.append({
                "post_id": post_id,
                "title": title,
                "url": full_url
            })

        logger.info(f"페이지 {page}: {len(items)}건 발견")
        return items

    def crawl_post(self, post_id: str, title: str = "", url: str = "") -> dict | None:
        """
        상세 페이지 본문 크롤링 → JSON 파일 저장
        이미 파일이 존재하면 스킵
        """
        filepath = os.path.join(DATA_PATH, f"{post_id}.json")
        if os.path.exists(filepath):
            logger.debug(f"이미 존재: {post_id}")
            return None

        detail_url = url or f"{self.BASE_URL}/Community/game/{post_id}?SearchBoard=1"

        try:
            resp = requests.get(detail_url, headers=self.HEADERS, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            logger.error(f"게시글 {post_id} 요청 실패: {e}")
            return None

        soup = BeautifulSoup(resp.text, "html.parser")

        # 본문 추출
        board_text = soup.select_one(".board_text")
        if not board_text:
            logger.warning(f"게시글 {post_id}: 본문 선택자 .board_text 없음")
            return None

        # script/style 제거
        for tag in board_text.find_all(["script", "style"]):
            tag.decompose()

        # br → 개행, 텍스트 정리
        for br in board_text.find_all("br"):
            br.replace_with("\n")
        content = board_text.get_text(separator="\n")
        content = re.sub(r"\n{3,}", "\n\n", content).strip()

        # 이미지 추출 및 다운로드
        images = []
        if ImageHandler.is_enabled():
            images = self._extract_and_download_images(board_text, post_id)

        # 메타 정보 추출
        author = ""
        date = ""
        views = 0

        author_el = soup.select_one(".board_info .nick, .board_info .name")
        if author_el:
            author = author_el.get_text(strip=True)

        date_el = soup.select_one(".board_info .date, .board_info .time")
        if date_el:
            date = date_el.get_text(strip=True)

        views_el = soup.select_one(".board_info .view, .board_info .hit")
        if views_el:
            views_text = views_el.get_text(strip=True)
            views_match = re.search(r"[\d,]+", views_text)
            if views_match:
                views = int(views_match.group().replace(",", ""))

        # 제목 (목록에서 못 가져왔을 경우 상세 페이지에서 추출)
        if not title:
            title_el = soup.select_one(".board_title, .board_subject, h2.title")
            if title_el:
                title = title_el.get_text(strip=True)

        post_data = {
            "id": post_id,
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
            "url": detail_url,
            "source": "lod_nexon",
            "board_name": "현자의 마을",
            "crawled_at": datetime.now().isoformat(),
            "bookmark_created": False
        }

        # JSON 파일 저장
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(post_data, f, ensure_ascii=False, indent=2)

        logger.info(f"저장 완료: {post_id} - {title}")
        return post_data

    def crawl_all(self, start_page: int = 1, end_page: int = 20) -> dict:
        """전체 페이지 순회 크롤링"""
        total_new = 0
        total_skipped = 0

        for page in range(start_page, end_page + 1):
            items = self.crawl_list(page)
            if not items:
                logger.info(f"페이지 {page}: 게시글 없음, 크롤링 종료")
                break

            for item in items:
                self._delay()
                result = self.crawl_post(
                    post_id=item["post_id"],
                    title=item["title"],
                    url=item["url"]
                )
                if result:
                    total_new += 1
                else:
                    total_skipped += 1

            self._delay()

        stats = {"new": total_new, "skipped": total_skipped}
        logger.info(f"LOD 크롤링 완료: 신규 {total_new}건, 스킵 {total_skipped}건")
        return stats

    def crawl_new(self) -> dict:
        """
        1페이지만 크롤링 (스케줄러용).
        이미 크롤링된 게시글을 만나면 즉시 중단 → 불필요한 요청 최소화.
        """
        total_new = 0
        total_skipped = 0

        items = self.crawl_list(1)
        for item in items:
            # 이미 크롤링된 게시글이면 이후도 이미 있으므로 중단
            filepath = os.path.join(DATA_PATH, f"{item['post_id']}.json")
            if os.path.exists(filepath):
                logger.debug(f"기존 게시글 도달: {item['post_id']} → 크롤링 중단")
                total_skipped += 1
                break

            self._delay()
            result = self.crawl_post(
                post_id=item["post_id"],
                title=item["title"],
                url=item["url"]
            )
            if result:
                total_new += 1
            else:
                total_skipped += 1

        stats = {"new": total_new, "skipped": total_skipped}
        logger.info(f"LOD 신규 크롤링 완료: 신규 {total_new}건, 스킵 {total_skipped}건")
        return stats
