"""
2단계 RAG 검색 엔진
1단계: 질문 → Qdrant 책갈피 검색 (Top-K)
2단계: 책갈피 → 원본 JSON 로드 → GPT 답변 생성
"""

import json
import os

from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue
from loguru import logger
from dotenv import load_dotenv

from utils.image_handler import ImageHandler

load_dotenv(override=True)

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION = os.getenv("QDRANT_COLLECTION", "lod_bookmarks")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
BOOKMARK_TOP_K = int(os.getenv("BOOKMARK_TOP_K", "3"))
MAX_ANSWER_LENGTH = int(os.getenv("MAX_ANSWER_LENGTH", "300"))
SCORE_THRESHOLD = float(os.getenv("SCORE_THRESHOLD", "0.35"))

SYSTEM_PROMPT = """당신은 어둠의전설 게임 전문 도우미입니다.
아래에 제공되는 게시글 내용을 꼼꼼히 읽고 사용자 질문에 답변해주세요.
게시글에 없는 내용은 절대 추측하지 마세요.
답변은 핵심만, {max_length}자 이내로 간결하게 작성하세요.
게임 고유 용어(직업명, 스킬명, 아이템명 등)는 그대로 사용하세요."""


class Retriever:
    def __init__(self):
        self.openai = OpenAI()
        self.qdrant = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

    def _get_embedding(self, text: str) -> list[float]:
        """질문 텍스트 임베딩"""
        response = self.openai.embeddings.create(
            model=EMBEDDING_MODEL,
            input=text
        )
        return response.data[0].embedding

    def _search_bookmarks(self, question: str, source_filter: str = None) -> list[dict]:
        """1단계: Qdrant에서 유사 책갈피 검색"""
        vector = self._get_embedding(question)

        # source 필터 (lod_nexon / naver_cafe / None=전체)
        query_filter = None
        if source_filter:
            query_filter = Filter(
                must=[FieldCondition(key="source", match=MatchValue(value=source_filter))]
            )

        try:
            response = self.qdrant.query_points(
                collection_name=COLLECTION,
                query=vector,
                query_filter=query_filter,
                limit=BOOKMARK_TOP_K,
                score_threshold=SCORE_THRESHOLD
            )
            results = response.points
        except Exception as e:
            logger.error(f"Qdrant 검색 실패: {e}")
            return []

        bookmarks = []
        for hit in results:
            payload = hit.payload
            payload["score"] = hit.score
            bookmarks.append(payload)

        return bookmarks

    def _load_original_data(self, content_path: str) -> dict:
        """책갈피의 content_path로 원본 JSON 로드 → 전체 dict 반환"""
        if not content_path:
            return {}

        # Docker 환경에서 상대경로 처리
        if content_path.startswith("./"):
            content_path = content_path[2:]
        filepath = os.path.join(os.getcwd(), content_path)

        if not os.path.exists(filepath):
            logger.warning(f"원본 파일 없음: {filepath}")
            return {}

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"원본 로드 실패 {filepath}: {e}")
            return {}

    def _build_context(self, bookmarks: list[dict]) -> dict:
        """
        GPT에 전달할 컨텍스트 구성.
        반환: {"text": str, "images": list[dict]}
        """
        context_parts = []
        all_images = []
        max_images_per_post = 3
        max_total_images = int(os.getenv("IMAGE_MAX_FOR_ANSWER", "6"))

        for i, bm in enumerate(bookmarks, 1):
            # 원본 전체 데이터 로드
            original_data = self._load_original_data(bm.get("content_path", ""))
            content = original_data.get("content", "") if original_data else ""

            # 원본 없으면 책갈피 summary로 대체
            if not content:
                content = bm.get("summary", "")

            # 너무 긴 본문은 잘라서 전달 (GPT 토큰 제한)
            if len(content) > 3000:
                content = content[:3000] + "..."

            # 이미지 설명 텍스트 (책갈피에서)
            image_desc = bm.get("image_descriptions", [])
            desc_text = ""
            if image_desc:
                desc_text = "\n이미지 설명: " + " / ".join(image_desc)

            part = (
                f"[게시글 {i}] {bm.get('board_name', '')} | {bm.get('date', '')}\n"
                f"제목: {bm.get('title', '')}\n"
                f"내용: {content}{desc_text}\n"
                f"출처: {bm.get('url', '')}"
            )
            context_parts.append(part)

            # 원본에서 이미지 수집 (총 개수 제한)
            if original_data and len(all_images) < max_total_images:
                post_images = original_data.get("images", [])
                remaining = max_total_images - len(all_images)
                all_images.extend(post_images[:min(max_images_per_post, remaining)])

        return {
            "text": "\n────────────\n".join(context_parts),
            "images": all_images
        }

    def _generate_answer(self, question: str, context_text: str,
                          images: list[dict] = None) -> str:
        """GPT-4o-mini로 최종 답변 생성 (이미지 있으면 Vision API 사용)"""
        system = SYSTEM_PROMPT.format(max_length=MAX_ANSWER_LENGTH)

        user_prompt = f"""참고 게시글:
{context_text}

────────────
사용자 질문: {question}"""

        # 이미지 base64 변환
        images_b64 = []
        if images and ImageHandler.is_enabled():
            images_b64 = ImageHandler.load_images_as_base64(images)

        if images_b64:
            user_content = ImageHandler.build_vision_messages(
                user_prompt, images_b64,
                detail=ImageHandler.IMAGE_VISION_DETAIL_ANSWER
            )
        else:
            user_content = user_prompt

        try:
            response = self.openai.chat.completions.create(
                model=LLM_MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_content}
                ],
                temperature=0.3,
                max_tokens=500
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            # Vision 실패 시 텍스트만으로 재시도
            if images_b64:
                logger.warning(f"Vision 답변 생성 실패, 텍스트만으로 재시도: {e}")
                return self._generate_answer(question, context_text, images=None)
            logger.error(f"GPT 답변 생성 실패: {e}")
            return "답변 생성 중 오류가 발생했습니다."

    @staticmethod
    def _get_confidence(top_score: float) -> str:
        """유사도 점수 → 신뢰도 등급"""
        if top_score >= 0.55:
            return "high"
        elif top_score >= 0.42:
            return "medium"
        elif top_score >= 0.35:
            return "low"
        else:
            return "not_found"

    def search(self, question: str, source_filter: str = None) -> dict:
        """
        메인 검색 메서드 (2단계 RAG)

        반환:
        {
            "answer": "AI 답변",
            "sources": [{"title", "url", "board_name", "date", "score"}],
            "confidence": "high|medium|low|not_found"
        }
        """
        # 1단계: 책갈피 검색
        bookmarks = self._search_bookmarks(question, source_filter)

        if not bookmarks:
            return {
                "answer": "관련 내용을 찾지 못했습니다.",
                "sources": [],
                "confidence": "not_found"
            }

        top_score = bookmarks[0].get("score", 0)
        confidence = self._get_confidence(top_score)

        # not_found는 답변 생성 생략
        if confidence == "not_found":
            return {
                "answer": "관련 내용을 찾지 못했습니다.",
                "sources": [],
                "confidence": "not_found"
            }

        # 2단계: 원본 내용 로드 + GPT 답변 (이미지 포함)
        context = self._build_context(bookmarks)
        answer = self._generate_answer(question, context["text"], context["images"])

        sources = [
            {
                "title": bm.get("title", ""),
                "url": bm.get("url", ""),
                "board_name": bm.get("board_name", ""),
                "date": bm.get("date", ""),
                "score": round(bm.get("score", 0), 4)
            }
            for bm in bookmarks
        ]

        return {
            "answer": answer,
            "sources": sources,
            "confidence": confidence
        }
