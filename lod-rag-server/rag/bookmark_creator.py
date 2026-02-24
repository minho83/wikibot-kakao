"""
책갈피(Bookmark) 생성기
원본 게시글을 GPT-4o-mini로 요약/키워드/태그 추출하여 책갈피 JSON 생성
"""

import json
import os
import glob
from datetime import datetime

from openai import OpenAI
from loguru import logger
from dotenv import load_dotenv

from utils.image_handler import ImageHandler

load_dotenv()

DATA_LOD_PATH = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
DATA_CAFE_PATH = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
DATA_BOOKMARK_PATH = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")


BOOKMARK_PROMPT = """다음은 어둠의전설 게임 관련 게시글입니다.
아래 JSON 형식으로 책갈피를 생성해주세요.
게임 고유 용어(직업명, 스킬명, 아이템명 등)는 절대 바꾸지 마세요.

출력 형식 (JSON만 출력, 다른 텍스트 없이):
{{
  "summary": "핵심 내용 3문장 이내 요약",
  "keywords": ["키워드1", "키워드2", "키워드3", ...],
  "category_tags": ["직업정보|스킬|아이템|퀘스트|던전|시스템|이벤트|기타 중 해당하는 것"]
}}

제목: {title}
게시판: {board_name}
본문:
{content}"""

BOOKMARK_PROMPT_WITH_IMAGES = """다음은 어둠의전설 게임 관련 게시글입니다.
첨부된 이미지와 본문을 모두 참고하여 책갈피를 생성해주세요.
이미지에 스킬트리, 아이템 스탯, 지도, 스크린샷 등이 있다면 핵심 정보를 추출하세요.
게임 고유 용어(직업명, 스킬명, 아이템명 등)는 절대 바꾸지 마세요.

출력 형식 (JSON만 출력, 다른 텍스트 없이):
{{
  "summary": "핵심 내용 3문장 이내 요약 (이미지 정보 포함)",
  "keywords": ["키워드1", "키워드2", "키워드3", ...],
  "category_tags": ["직업정보|스킬|아이템|퀘스트|던전|시스템|이벤트|기타 중 해당하는 것"],
  "image_descriptions": ["이미지1 설명: 무엇이 보이는지 구체적으로", "이미지2 설명: ..."]
}}

제목: {title}
게시판: {board_name}
본문:
{content}"""


class BookmarkCreator:
    def __init__(self):
        self.client = OpenAI()
        os.makedirs(DATA_BOOKMARK_PATH, exist_ok=True)

    def _call_gpt(self, title: str, board_name: str, content: str,
                   images: list[dict] = None) -> dict | None:
        """GPT-4o-mini로 책갈피 데이터 추출 (이미지 있으면 Vision API 사용)"""
        # 본문이 너무 길면 잘라서 전송 (토큰 절약)
        truncated_content = content[:4000] if len(content) > 4000 else content

        # 이미지 base64 변환
        images_b64 = []
        if images and ImageHandler.is_enabled():
            images_b64 = ImageHandler.load_images_as_base64(
                images, max_count=ImageHandler.IMAGE_MAX_FOR_BOOKMARK
            )

        # 이미지 유무에 따라 프롬프트/메시지 분기
        if images_b64:
            prompt_text = BOOKMARK_PROMPT_WITH_IMAGES.format(
                title=title, board_name=board_name, content=truncated_content
            )
            user_content = ImageHandler.build_vision_messages(
                prompt_text, images_b64,
                detail=ImageHandler.IMAGE_VISION_DETAIL_BOOKMARK
            )
            max_tokens = 800
        else:
            prompt_text = BOOKMARK_PROMPT.format(
                title=title, board_name=board_name, content=truncated_content
            )
            user_content = prompt_text
            max_tokens = 500

        try:
            response = self.client.chat.completions.create(
                model=LLM_MODEL,
                messages=[{"role": "user", "content": user_content}],
                temperature=0.3,
                max_tokens=max_tokens,
                response_format={"type": "json_object"}
            )
            result_text = response.choices[0].message.content.strip()
            return json.loads(result_text)
        except json.JSONDecodeError as e:
            logger.error(f"GPT 응답 JSON 파싱 실패: {e}")
            return None
        except Exception as e:
            # Vision 실패 시 텍스트만으로 재시도
            if images_b64:
                logger.warning(f"Vision 호출 실패, 텍스트만으로 재시도: {e}")
                return self._call_gpt(title, board_name, content, images=None)
            logger.error(f"GPT 호출 실패: {e}")
            return None

    def create_bookmark(self, raw_post: dict) -> dict | None:
        """단일 게시글 → 책갈피 생성"""
        source = raw_post.get("source", "unknown")
        post_id = raw_post.get("id", "")
        bookmark_id = f"{source}_{post_id}"

        # 이미 책갈피 존재 확인
        bookmark_path = os.path.join(DATA_BOOKMARK_PATH, f"{bookmark_id}.json")
        if os.path.exists(bookmark_path):
            logger.debug(f"이미 존재: {bookmark_id}")
            return None

        title = raw_post.get("title", "")
        board_name = raw_post.get("board_name", "")
        content = raw_post.get("content", "")

        images = raw_post.get("images", [])

        if not content or len(content.strip()) < 20:
            logger.warning(f"본문이 너무 짧음: {bookmark_id} ({len(content)}자)")
            return None

        # GPT 호출 (이미지 있으면 Vision API)
        gpt_result = self._call_gpt(title, board_name, content, images=images)
        if not gpt_result:
            return None

        # content_path 결정
        if source == "lod_nexon":
            content_path = f"./data/lod_nexon/{post_id}.json"
        elif source == "naver_cafe":
            content_path = f"./data/naver_cafe/{post_id}.json"
        else:
            content_path = f"./data/{source}/{post_id}.json"

        bookmark = {
            "bookmark_id": bookmark_id,
            "title": title,
            "summary": gpt_result.get("summary", ""),
            "keywords": gpt_result.get("keywords", []),
            "category_tags": gpt_result.get("category_tags", []),
            "image_descriptions": gpt_result.get("image_descriptions", []),
            "source": source,
            "board_name": board_name,
            "date": raw_post.get("date", ""),
            "views": raw_post.get("views", 0),
            "url": raw_post.get("url", ""),
            "content_path": content_path,
            "created_at": datetime.now().isoformat()
        }

        # 책갈피 JSON 저장
        with open(bookmark_path, "w", encoding="utf-8") as f:
            json.dump(bookmark, f, ensure_ascii=False, indent=2)

        # 원본 JSON의 bookmark_created 플래그 업데이트
        self._update_original(raw_post, source, post_id)

        logger.info(f"책갈피 생성: {bookmark_id} - {title}")
        return bookmark

    def _update_original(self, raw_post: dict, source: str, post_id: str):
        """원본 JSON의 bookmark_created → True 업데이트"""
        if source == "lod_nexon":
            original_path = os.path.join(DATA_LOD_PATH, f"{post_id}.json")
        elif source == "naver_cafe":
            original_path = os.path.join(DATA_CAFE_PATH, f"{post_id}.json")
        else:
            return

        if os.path.exists(original_path):
            try:
                with open(original_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                data["bookmark_created"] = True
                with open(original_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            except Exception as e:
                logger.error(f"원본 업데이트 실패 {original_path}: {e}")

    def _load_raw_posts(self, data_path: str) -> list[dict]:
        """디렉토리에서 bookmark_created=false인 원본 파일 로드"""
        posts = []
        for filepath in glob.glob(os.path.join(data_path, "*.json")):
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not data.get("bookmark_created", False) and not data.get("excluded", False):
                    posts.append(data)
            except Exception as e:
                logger.error(f"파일 로드 실패 {filepath}: {e}")
        return posts

    def create_all(self) -> dict:
        """bookmark_created=false인 전체 원본 처리"""
        posts = []
        posts.extend(self._load_raw_posts(DATA_LOD_PATH))
        posts.extend(self._load_raw_posts(DATA_CAFE_PATH))

        created = 0
        failed = 0
        for post in posts:
            result = self.create_bookmark(post)
            if result:
                created += 1
            else:
                failed += 1

        stats = {"created": created, "failed": failed, "total": len(posts)}
        logger.info(f"책갈피 생성 완료: {created}건 생성, {failed}건 실패/스킵 (총 {len(posts)}건)")
        return stats

    def create_new(self) -> dict:
        """최근 크롤링된 신규 파일만 처리 (create_all과 동일 로직)"""
        return self.create_all()
