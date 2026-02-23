"""
LOD RAG Server - FastAPI 메인 서버
책갈피 2단계 RAG 검색 + 크롤링 관리 API
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
from loguru import logger
from dotenv import load_dotenv

load_dotenv()

from rag.retriever import Retriever
from rag.bookmark_creator import BookmarkCreator
from rag.embedder import Embedder
from crawler.lod_crawler import LodCrawler
from crawler.naver_cafe_crawler import NaverCafeCrawler, CookieExpiredException
from scheduler.job import start_scheduler, stop_scheduler

ADMIN_SECRET_KEY = os.getenv("ADMIN_SECRET_KEY", "your-secret-key")

# 전역 인스턴스
retriever = None
embedder = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 시작/종료 시 리소스 관리"""
    global retriever, embedder

    logger.info("LOD RAG Server 시작 중...")

    # Qdrant 연결 + 서비스 초기화
    try:
        retriever = Retriever()
        embedder = Embedder()
        logger.info("Qdrant 연결 완료")
    except Exception as e:
        logger.error(f"Qdrant 연결 실패: {e}")
        retriever = None
        embedder = None

    # 스케줄러 시작
    start_scheduler()

    yield

    # 정리
    stop_scheduler()
    logger.info("LOD RAG Server 종료")


app = FastAPI(
    title="LOD RAG Server",
    description="어둠의전설 게임 정보 책갈피 RAG 검색 서버",
    version="1.0.0",
    lifespan=lifespan
)


# ─── Request/Response 모델 ───

class SearchRequest(BaseModel):
    query: str
    source_filter: Optional[str] = None  # "lod_nexon" | "naver_cafe" | None

class AddRequest(BaseModel):
    title: str
    content: str
    board_name: str
    source_url: str
    source: str  # "lod_nexon" | "naver_cafe"

class CrawlRequest(BaseModel):
    source: str = "all"  # "all" | "lod" | "cafe"
    pages: int = 5


# ─── 엔드포인트 ───

@app.post("/search")
async def search(req: SearchRequest):
    """
    책갈피 2단계 RAG 검색 + 답변 생성
    wikibot /ask/search에서 호출
    """
    if not retriever:
        raise HTTPException(status_code=503, detail="RAG 서비스 초기화 중")

    if not req.query.strip():
        raise HTTPException(status_code=400, detail="검색어를 입력해주세요")

    result = retriever.search(
        question=req.query.strip(),
        source_filter=req.source_filter
    )
    return result


@app.post("/add")
async def add(req: AddRequest):
    """수동 데이터 추가 → 책갈피 생성 → 임베딩"""
    import json
    from datetime import datetime

    # 원본 저장
    source = req.source
    if source == "lod_nexon":
        data_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    elif source == "naver_cafe":
        data_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    else:
        raise HTTPException(status_code=400, detail="source는 lod_nexon 또는 naver_cafe")

    # 간단한 ID 생성 (타임스탬프 기반)
    post_id = f"manual_{int(datetime.now().timestamp())}"
    raw_post = {
        "id": post_id,
        "title": req.title,
        "author": "수동입력",
        "date": datetime.now().strftime("%Y.%m.%d"),
        "views": 0,
        "content": req.content,
        "url": req.source_url,
        "source": source,
        "board_name": req.board_name,
        "crawled_at": datetime.now().isoformat(),
        "bookmark_created": False
    }

    os.makedirs(data_path, exist_ok=True)
    filepath = os.path.join(data_path, f"{post_id}.json")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(raw_post, f, ensure_ascii=False, indent=2)

    # 책갈피 생성
    creator = BookmarkCreator()
    bookmark = creator.create_bookmark(raw_post)
    if not bookmark:
        return {"success": False, "message": "책갈피 생성 실패"}

    # 임베딩
    if embedder:
        embedder.embed_and_save(bookmark)

    return {"success": True, "bookmark_id": bookmark["bookmark_id"]}


@app.get("/health")
async def health():
    """헬스체크"""
    qdrant_status = "connected" if embedder else "disconnected"
    stats = embedder.get_stats() if embedder else {}

    return {
        "status": "healthy" if embedder else "degraded",
        "qdrant": qdrant_status,
        **stats
    }


@app.get("/stats")
async def stats():
    """수집 현황"""
    import glob

    lod_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    cafe_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    bookmark_path = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")

    lod_count = len(glob.glob(os.path.join(lod_path, "*.json")))
    cafe_count = len(glob.glob(os.path.join(cafe_path, "*.json")))
    bookmark_count = len(glob.glob(os.path.join(bookmark_path, "*.json")))

    qdrant_stats = embedder.get_stats() if embedder else {}

    return {
        "raw_posts": {
            "lod_nexon": lod_count,
            "naver_cafe": cafe_count
        },
        "bookmarks": bookmark_count,
        "qdrant": qdrant_stats
    }


@app.post("/crawl")
async def crawl(
    req: CrawlRequest,
    background_tasks: BackgroundTasks,
    x_admin_key: str = Header(None)
):
    """관리자 수동 크롤링 트리거"""
    if x_admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="인증 실패")

    async def run_crawl():
        lod_stats = {"new": 0}
        cafe_stats = {"new": 0}

        if req.source in ("all", "lod"):
            crawler = LodCrawler()
            lod_stats = crawler.crawl_all(start_page=1, end_page=req.pages)

        if req.source in ("all", "cafe"):
            try:
                cafe_crawler = NaverCafeCrawler()
                cafe_stats = await cafe_crawler.crawl_all_boards(pages_per_board=req.pages)
            except CookieExpiredException:
                logger.warning("네이버 쿠키 만료 — 카페 크롤링 스킵")
            except FileNotFoundError as e:
                logger.warning(f"쿠키 파일 없음: {e}")

        # 책갈피 + 임베딩
        creator = BookmarkCreator()
        bm_stats = creator.create_all()

        if embedder:
            embedder.process_all()

        logger.info(
            f"수동 크롤링 완료: LOD {lod_stats['new']}건, 카페 {cafe_stats['new']}건, "
            f"책갈피 {bm_stats['created']}건"
        )

    background_tasks.add_task(run_crawl)
    return {"message": "크롤링 작업 시작됨 (백그라운드 실행)"}
