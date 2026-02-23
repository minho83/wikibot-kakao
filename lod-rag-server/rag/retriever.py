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

load_dotenv()

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION = os.getenv("QDRANT_COLLECTION", "lod_bookmarks")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
BOOKMARK_TOP_K = int(os.getenv("BOOKMARK_TOP_K", "3"))
MAX_ANSWER_LENGTH = int(os.getenv("MAX_ANSWER_LENGTH", "300"))
SCORE_THRESHOLD = float(os.getenv("SCORE_THRESHOLD", "0.50"))

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
            results = self.qdrant.search(
                collection_name=COLLECTION,
                query_vector=vector,
                query_filter=query_filter,
                limit=BOOKMARK_TOP_K,
                score_threshold=SCORE_THRESHOLD
            )
        except Exception as e:
            logger.error(f"Qdrant 검색 실패: {e}")
            return []

        bookmarks = []
        for hit in results:
            payload = hit.payload
            payload["score"] = hit.score
            bookmarks.append(payload)

        return bookmarks

    def _load_original_content(self, content_path: str) -> str:
        """책갈피의 content_path로 원본 JSON 로드 → content 반환"""
        if not content_path:
            return ""

        # Docker 환경에서 상대경로 처리
        if content_path.startswith("./"):
            content_path = content_path[2:]
        filepath = os.path.join(os.getcwd(), content_path)

        if not os.path.exists(filepath):
            logger.warning(f"원본 파일 없음: {filepath}")
            return ""

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("content", "")
        except Exception as e:
            logger.error(f"원본 로드 실패 {filepath}: {e}")
            return ""

    def _build_context(self, bookmarks: list[dict]) -> str:
        """GPT에 전달할 컨텍스트 구성"""
        context_parts = []

        for i, bm in enumerate(bookmarks, 1):
            # 원본 전체 내용 로드 시도
            original_content = self._load_original_content(bm.get("content_path", ""))

            # 원본 없으면 책갈피 summary로 대체
            content = original_content if original_content else bm.get("summary", "")

            # 너무 긴 본문은 잘라서 전달 (GPT 토큰 제한)
            if len(content) > 3000:
                content = content[:3000] + "..."

            part = (
                f"[게시글 {i}] {bm.get('board_name', '')} | {bm.get('date', '')}\n"
                f"제목: {bm.get('title', '')}\n"
                f"내용: {content}\n"
                f"출처: {bm.get('url', '')}"
            )
            context_parts.append(part)

        return "\n────────────\n".join(context_parts)

    def _generate_answer(self, question: str, context: str) -> str:
        """GPT-4o-mini로 최종 답변 생성"""
        system = SYSTEM_PROMPT.format(max_length=MAX_ANSWER_LENGTH)

        user_prompt = f"""참고 게시글:
{context}

────────────
사용자 질문: {question}"""

        try:
            response = self.openai.chat.completions.create(
                model=LLM_MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.3,
                max_tokens=500
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"GPT 답변 생성 실패: {e}")
            return "답변 생성 중 오류가 발생했습니다."

    @staticmethod
    def _get_confidence(top_score: float) -> str:
        """유사도 점수 → 신뢰도 등급"""
        if top_score >= 0.70:
            return "high"
        elif top_score >= 0.55:
            return "medium"
        elif top_score >= 0.45:
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

        # 2단계: 원본 내용 로드 + GPT 답변
        context = self._build_context(bookmarks)
        answer = self._generate_answer(question, context)

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
