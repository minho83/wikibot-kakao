"""
책갈피 임베딩 → Qdrant 벡터 DB 저장
"""

import json
import os
import glob
import uuid

from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue
)
from loguru import logger
from dotenv import load_dotenv

load_dotenv()

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION = os.getenv("QDRANT_COLLECTION", "lod_bookmarks")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
DATA_BOOKMARK_PATH = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")

VECTOR_SIZE = 1536  # text-embedding-3-small 차원


class Embedder:
    def __init__(self):
        self.openai = OpenAI()
        self.qdrant = QdrantClient(url=f"http://{QDRANT_HOST}:{QDRANT_PORT}")
        self._ensure_collection()

    def _ensure_collection(self):
        """Qdrant 컬렉션 없으면 생성"""
        collections = [c.name for c in self.qdrant.get_collections().collections]
        if COLLECTION not in collections:
            self.qdrant.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(
                    size=VECTOR_SIZE,
                    distance=Distance.COSINE
                )
            )
            logger.info(f"Qdrant 컬렉션 생성: {COLLECTION}")
        else:
            logger.debug(f"Qdrant 컬렉션 존재: {COLLECTION}")

    @staticmethod
    def _bookmark_id_to_uuid(bookmark_id: str) -> str:
        """bookmark_id 문자열 → 결정적 UUID 변환"""
        return str(uuid.uuid5(uuid.NAMESPACE_URL, bookmark_id))

    @staticmethod
    def build_embed_text(bookmark: dict) -> str:
        """임베딩할 텍스트 구성 (짧고 정확하게)"""
        title = bookmark.get("title", "")
        summary = bookmark.get("summary", "")
        keywords = ", ".join(bookmark.get("keywords", []))
        category_tags = ", ".join(bookmark.get("category_tags", []))
        board_name = bookmark.get("board_name", "")

        text = f"제목: {title}\n요약: {summary}\n키워드: {keywords}\n카테고리: {category_tags}\n게시판: {board_name}"

        # 이미지 설명이 있으면 임베딩 텍스트에 추가
        image_descriptions = bookmark.get("image_descriptions", [])
        if image_descriptions:
            desc_text = " / ".join(image_descriptions)
            text += f"\n이미지 내용: {desc_text}"

        return text

    def _get_embedding(self, text: str) -> list[float]:
        """OpenAI 임베딩 API 호출"""
        response = self.openai.embeddings.create(
            model=EMBEDDING_MODEL,
            input=text
        )
        return response.data[0].embedding

    def embed_and_save(self, bookmark: dict) -> bool:
        """단일 책갈피 임베딩 → Qdrant 저장"""
        bookmark_id = bookmark.get("bookmark_id", "")
        if not bookmark_id:
            logger.error("bookmark_id 없음")
            return False

        point_id = self._bookmark_id_to_uuid(bookmark_id)
        embed_text = self.build_embed_text(bookmark)

        try:
            vector = self._get_embedding(embed_text)
        except Exception as e:
            logger.error(f"임베딩 실패 {bookmark_id}: {e}")
            return False

        # 페이로드 (검색 후 원본 로드에 사용)
        payload = {
            "bookmark_id": bookmark_id,
            "title": bookmark.get("title", ""),
            "summary": bookmark.get("summary", ""),
            "keywords": bookmark.get("keywords", []),
            "image_descriptions": bookmark.get("image_descriptions", []),
            "source": bookmark.get("source", ""),
            "board_name": bookmark.get("board_name", ""),
            "date": bookmark.get("date", ""),
            "url": bookmark.get("url", ""),
            "content_path": bookmark.get("content_path", "")
        }

        try:
            self.qdrant.upsert(
                collection_name=COLLECTION,
                points=[
                    PointStruct(
                        id=point_id,
                        vector=vector,
                        payload=payload
                    )
                ]
            )
            logger.debug(f"Qdrant 저장: {bookmark_id}")
            return True
        except Exception as e:
            logger.error(f"Qdrant 저장 실패 {bookmark_id}: {e}")
            return False

    def delete_by_bookmark_id(self, bookmark_id: str) -> bool:
        """Qdrant에서 bookmark_id로 벡터 삭제"""
        point_id = self._bookmark_id_to_uuid(bookmark_id)
        try:
            self.qdrant.delete(
                collection_name=COLLECTION,
                points_selector=[point_id]
            )
            logger.info(f"Qdrant 삭제: {bookmark_id}")
            return True
        except Exception as e:
            logger.error(f"Qdrant 삭제 실패 {bookmark_id}: {e}")
            return False

    def _is_in_qdrant(self, bookmark_id: str) -> bool:
        """Qdrant에 이미 존재하는지 확인"""
        point_id = self._bookmark_id_to_uuid(bookmark_id)
        try:
            result = self.qdrant.retrieve(
                collection_name=COLLECTION,
                ids=[point_id]
            )
            return len(result) > 0
        except Exception:
            return False

    def process_all(self) -> dict:
        """data/bookmarks/*.json 중 Qdrant에 없는 것 전체 처리"""
        saved = 0
        skipped = 0
        failed = 0

        for filepath in glob.glob(os.path.join(DATA_BOOKMARK_PATH, "*.json")):
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    bookmark = json.load(f)
            except Exception as e:
                logger.error(f"파일 로드 실패 {filepath}: {e}")
                failed += 1
                continue

            bookmark_id = bookmark.get("bookmark_id", "")
            if self._is_in_qdrant(bookmark_id):
                skipped += 1
                continue

            if self.embed_and_save(bookmark):
                saved += 1
            else:
                failed += 1

        stats = {"saved": saved, "skipped": skipped, "failed": failed}
        logger.info(f"임베딩 완료: {saved}건 저장, {skipped}건 스킵, {failed}건 실패")
        return stats

    def process_new(self) -> dict:
        """신규 책갈피 파일만 처리 (process_all과 동일 로직)"""
        return self.process_all()

    def get_stats(self) -> dict:
        """Qdrant 컬렉션 통계"""
        try:
            info = self.qdrant.get_collection(COLLECTION)
            total = info.points_count

            # source별 카운트
            lod_count = self.qdrant.count(
                collection_name=COLLECTION,
                count_filter=Filter(
                    must=[FieldCondition(key="source", match=MatchValue(value="lod_nexon"))]
                )
            ).count

            cafe_count = self.qdrant.count(
                collection_name=COLLECTION,
                count_filter=Filter(
                    must=[FieldCondition(key="source", match=MatchValue(value="naver_cafe"))]
                )
            ).count

            return {
                "total_bookmarks": total,
                "lod_nexon": lod_count,
                "naver_cafe": cafe_count
            }
        except Exception as e:
            logger.error(f"Qdrant 통계 조회 실패: {e}")
            return {"total_bookmarks": 0, "lod_nexon": 0, "naver_cafe": 0}
