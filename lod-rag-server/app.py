"""
LOD RAG Server - FastAPI 메인 서버
책갈피 2단계 RAG 검색 + 크롤링 관리 API
"""

import os
import re
import json
import glob as glob_module
from contextlib import asynccontextmanager
from datetime import datetime
from urllib.parse import urlparse, parse_qs

from fastapi import FastAPI, HTTPException, Header, BackgroundTasks, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
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

    # Qdrant 연결 + 서비스 초기화 (재시도 포함)
    import asyncio
    for attempt in range(5):
        try:
            retriever = Retriever()
            embedder = Embedder()
            logger.info("Qdrant 연결 완료")
            break
        except Exception as e:
            logger.warning(f"Qdrant 연결 실패 (시도 {attempt + 1}/5): {e}")
            retriever = None
            embedder = None
            if attempt < 4:
                await asyncio.sleep(3)

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

class CrawlUrlRequest(BaseModel):
    url: str


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

    # 이미지 통계
    lod_img_count = 0
    cafe_img_count = 0
    lod_img_dir = os.path.join(lod_path, "images")
    cafe_img_dir = os.path.join(cafe_path, "images")
    if os.path.isdir(lod_img_dir):
        lod_img_count = len(os.listdir(lod_img_dir))
    if os.path.isdir(cafe_img_dir):
        cafe_img_count = len(os.listdir(cafe_img_dir))

    return {
        "raw_posts": {
            "lod_nexon": lod_count,
            "naver_cafe": cafe_count
        },
        "images": {
            "lod_nexon": lod_img_count,
            "naver_cafe": cafe_img_count
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


@app.post("/admin/crawl-url")
async def crawl_url(
    req: CrawlUrlRequest,
    x_admin_key: str = Header(None)
):
    """URL로 단건 게시글 수동 크롤링 → 책갈피 → 임베딩"""
    if x_admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="인증 실패")

    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL을 입력해주세요")

    parsed = urlparse(url)
    host = parsed.hostname or ""

    # ── 소스 판별 + ID 추출 ──
    if "cafe.naver.com" in host:
        source = "naver_cafe"
        # /articles/{id} 또는 /f-e/{id}
        m = re.search(r"/articles/(\d+)", parsed.path)
        if not m:
            m = re.search(r"/f-e/(\d+)(?:\?|$)", url)
        if not m:
            raise HTTPException(status_code=400, detail="카페 게시글 ID를 URL에서 찾을 수 없습니다")
        post_id = m.group(1)

        # menu_id 추출 시도
        qs = parse_qs(parsed.query)
        menu_id = int(qs.get("menuid", qs.get("menuId", [0]))[0])

    elif "lod.nexon.com" in host:
        source = "lod_nexon"
        m = re.search(r"/Community/game/(\d+)", parsed.path)
        if not m:
            raise HTTPException(status_code=400, detail="LOD 게시글 ID를 URL에서 찾을 수 없습니다")
        post_id = m.group(1)

    else:
        raise HTTPException(
            status_code=400,
            detail="지원하지 않는 URL입니다. 네이버 카페 또는 LOD 공홈 URL을 입력해주세요."
        )

    # ── 이미 수집된 게시글 확인 ──
    if source == "lod_nexon":
        data_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    else:
        data_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")

    filepath = os.path.join(data_path, f"{post_id}.json")
    if os.path.exists(filepath):
        # 이미 수집됨 → 책갈피/임베딩만 재처리
        with open(filepath, "r", encoding="utf-8") as f:
            raw_post = json.load(f)

        bookmark_id = f"{source}_{post_id}"
        bm_path = os.path.join(os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks"), f"{bookmark_id}.json")

        if os.path.exists(bm_path):
            return {
                "success": True,
                "message": "이미 수집 및 학습된 게시글입니다",
                "post_id": post_id,
                "title": raw_post.get("title", ""),
                "source": source,
                "already_exists": True
            }

        # 책갈피 미생성 → 생성 진행
        creator = BookmarkCreator()
        bookmark = creator.create_bookmark(raw_post)
        if bookmark and embedder:
            embedder.embed_and_save(bookmark)

        return {
            "success": True,
            "message": "기존 게시글의 책갈피를 생성했습니다",
            "post_id": post_id,
            "title": raw_post.get("title", ""),
            "source": source,
            "bookmark_id": bookmark["bookmark_id"] if bookmark else None
        }

    # ── 크롤링 실행 ──
    raw_post = None

    if source == "lod_nexon":
        crawler = LodCrawler()
        raw_post = crawler.crawl_post(post_id, title="", url=url)

    elif source == "naver_cafe":
        try:
            cafe_crawler = NaverCafeCrawler()
            context = await cafe_crawler.load_session()
            try:
                raw_post = await cafe_crawler.crawl_post(
                    context, article_id=post_id,
                    menu_id=menu_id, board_name="수동수집"
                )
            finally:
                await cafe_crawler._cleanup()
        except CookieExpiredException:
            raise HTTPException(status_code=500, detail="네이버 쿠키가 만료되었습니다. 쿠키를 갱신해주세요.")
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="네이버 쿠키 파일이 없습니다.")

    if not raw_post:
        raise HTTPException(status_code=500, detail="게시글 크롤링에 실패했습니다. URL을 확인해주세요.")

    # ── 책갈피 생성 + 임베딩 ──
    creator = BookmarkCreator()
    bookmark = creator.create_bookmark(raw_post)
    bookmark_id = None
    if bookmark:
        bookmark_id = bookmark["bookmark_id"]
        if embedder:
            embedder.embed_and_save(bookmark)

    return {
        "success": True,
        "message": "크롤링 및 학습 완료",
        "post_id": post_id,
        "title": raw_post.get("title", ""),
        "source": source,
        "bookmark_id": bookmark_id
    }


# ─── 관리 페이지 ───

@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    """관리 페이지 HTML 반환"""
    html_path = os.path.join(os.path.dirname(__file__), "static", "admin.html")
    if not os.path.exists(html_path):
        raise HTTPException(status_code=404, detail="관리 페이지 파일 없음")
    with open(html_path, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())


@app.get("/admin/posts")
async def admin_list_posts(
    source: Optional[str] = Query(None, description="lod_nexon | naver_cafe"),
    status: Optional[str] = Query(None, description="all | excluded | included | no_bookmark"),
    search: Optional[str] = Query(None, description="제목 검색어"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=10, le=200),
    x_admin_key: str = Header(None)
):
    """크롤링된 게시글 목록 조회"""
    if x_admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="인증 실패")

    lod_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    cafe_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    bookmark_path = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")

    posts = []

    # 소스별 파일 로드
    paths = []
    if source != "naver_cafe":
        paths.extend(glob_module.glob(os.path.join(lod_path, "*.json")))
    if source != "lod_nexon":
        paths.extend(glob_module.glob(os.path.join(cafe_path, "*.json")))

    for filepath in paths:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            post_source = data.get("source", "")
            post_id = data.get("id", "")
            excluded = data.get("excluded", False)
            bookmark_created = data.get("bookmark_created", False)

            # 상태 필터
            if status == "excluded" and not excluded:
                continue
            if status == "included" and excluded:
                continue
            if status == "no_bookmark" and bookmark_created:
                continue

            # 검색 필터
            if search and search.lower() not in data.get("title", "").lower():
                continue

            # 이미지 개수
            image_count = len(data.get("images", []))

            # 책갈피 존재 확인
            bm_id = f"{post_source}_{post_id}"
            bm_path = os.path.join(bookmark_path, f"{bm_id}.json")
            has_bookmark = os.path.exists(bm_path)

            posts.append({
                "id": post_id,
                "source": post_source,
                "title": data.get("title", ""),
                "author": data.get("author", ""),
                "date": data.get("date", ""),
                "views": data.get("views", 0),
                "board_name": data.get("board_name", ""),
                "excluded": excluded,
                "bookmark_created": bookmark_created,
                "has_bookmark": has_bookmark,
                "image_count": image_count,
                "crawled_at": data.get("crawled_at", ""),
                "url": data.get("url", ""),
            })

        except Exception as e:
            logger.error(f"관리 목록 로드 실패 {filepath}: {e}")

    # 날짜순 정렬 (최신순)
    posts.sort(key=lambda x: x.get("crawled_at", ""), reverse=True)

    # 페이지네이션
    total = len(posts)
    start = (page - 1) * per_page
    end = start + per_page
    paged_posts = posts[start:end]

    return {
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": (total + per_page - 1) // per_page,
        "posts": paged_posts
    }


@app.get("/admin/posts/{source}/{post_id}")
async def admin_get_post(
    source: str, post_id: str,
    x_admin_key: str = Header(None)
):
    """게시글 상세 조회"""
    if x_admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="인증 실패")

    if source == "lod_nexon":
        data_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    elif source == "naver_cafe":
        data_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    else:
        raise HTTPException(status_code=400, detail="source: lod_nexon 또는 naver_cafe")

    filepath = os.path.join(data_path, f"{post_id}.json")
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="게시글 없음")

    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 책갈피 정보
    bookmark_path = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")
    bm_id = f"{source}_{post_id}"
    bm_filepath = os.path.join(bookmark_path, f"{bm_id}.json")
    bookmark = None
    if os.path.exists(bm_filepath):
        with open(bm_filepath, "r", encoding="utf-8") as f:
            bookmark = json.load(f)

    return {
        "post": data,
        "bookmark": bookmark
    }


@app.post("/admin/posts/{source}/{post_id}/exclude")
async def admin_exclude_post(
    source: str, post_id: str,
    x_admin_key: str = Header(None)
):
    """
    게시글 제외 처리:
    1. 원본 JSON에 excluded=True 설정
    2. Qdrant에서 벡터 삭제
    3. 책갈피 JSON 삭제
    """
    if x_admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="인증 실패")

    if source == "lod_nexon":
        data_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    elif source == "naver_cafe":
        data_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    else:
        raise HTTPException(status_code=400, detail="source: lod_nexon 또는 naver_cafe")

    filepath = os.path.join(data_path, f"{post_id}.json")
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="게시글 없음")

    # 1. 원본 JSON에 excluded 플래그 설정
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["excluded"] = True
    data["excluded_at"] = datetime.now().isoformat()
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # 2. Qdrant에서 벡터 삭제
    bookmark_id = f"{source}_{post_id}"
    qdrant_deleted = False
    if embedder:
        qdrant_deleted = embedder.delete_by_bookmark_id(bookmark_id)

    # 3. 책갈피 JSON 삭제
    bookmark_path = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")
    bm_filepath = os.path.join(bookmark_path, f"{bookmark_id}.json")
    bookmark_deleted = False
    if os.path.exists(bm_filepath):
        os.remove(bm_filepath)
        bookmark_deleted = True

    logger.info(f"게시글 제외: {bookmark_id} (Qdrant: {qdrant_deleted}, 책갈피: {bookmark_deleted})")

    return {
        "success": True,
        "post_id": post_id,
        "source": source,
        "qdrant_deleted": qdrant_deleted,
        "bookmark_deleted": bookmark_deleted
    }


@app.post("/admin/posts/{source}/{post_id}/include")
async def admin_include_post(
    source: str, post_id: str,
    x_admin_key: str = Header(None)
):
    """
    게시글 제외 해제:
    1. 원본 JSON에서 excluded 플래그 제거
    2. bookmark_created를 False로 (다음 크롤링 사이클에서 재생성)
    """
    if x_admin_key != ADMIN_SECRET_KEY:
        raise HTTPException(status_code=403, detail="인증 실패")

    if source == "lod_nexon":
        data_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    elif source == "naver_cafe":
        data_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    else:
        raise HTTPException(status_code=400, detail="source: lod_nexon 또는 naver_cafe")

    filepath = os.path.join(data_path, f"{post_id}.json")
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="게시글 없음")

    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["excluded"] = False
    data.pop("excluded_at", None)
    data["bookmark_created"] = False  # 다음 사이클에서 재생성 대상
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    logger.info(f"게시글 포함 복원: {source}_{post_id}")

    return {
        "success": True,
        "post_id": post_id,
        "source": source,
        "message": "제외 해제됨. 다음 책갈피 생성 사이클에서 자동 처리됩니다."
    }
