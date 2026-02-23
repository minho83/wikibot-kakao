"""
LOD RAG Server CLI
수동 크롤링, 책갈피 생성, 임베딩, 검색 테스트용
"""

import argparse
import json
import sys

from loguru import logger
from dotenv import load_dotenv

load_dotenv(override=True)


def cmd_crawl_lod(args):
    """LOD 공홈 크롤링"""
    from crawler.lod_crawler import LodCrawler

    crawler = LodCrawler()
    stats = crawler.crawl_all(start_page=1, end_page=args.pages)
    print(f"\n[완료] LOD 크롤링: 신규 {stats['new']}건, 스킵 {stats['skipped']}건")


def cmd_crawl_cafe(args):
    """네이버 카페 크롤링"""
    import asyncio
    from crawler.naver_cafe_crawler import NaverCafeCrawler, CookieExpiredException

    async def run():
        crawler = NaverCafeCrawler()
        try:
            if args.pages == 1:
                stats = await crawler.crawl_new()
            else:
                stats = await crawler.crawl_all_boards(pages_per_board=args.pages)
            print(f"\n[완료] 카페 크롤링: 신규 {stats['new']}건, 스킵 {stats['skipped']}건")
        except CookieExpiredException:
            print("\n[오류] 네이버 쿠키가 만료되었습니다!")
            print("로컬 PC에서 save_cookies_local.py를 실행하세요.")
        except FileNotFoundError as e:
            print(f"\n[오류] {e}")

    asyncio.run(run())


def cmd_create_bookmarks(args):
    """책갈피 생성"""
    from rag.bookmark_creator import BookmarkCreator

    creator = BookmarkCreator()
    stats = creator.create_all()
    print(f"\n[완료] 책갈피 생성: {stats['created']}건 생성, {stats['failed']}건 실패 (총 {stats['total']}건)")


def cmd_embed_all(args):
    """전체 임베딩"""
    from rag.embedder import Embedder

    embedder = Embedder()
    stats = embedder.process_all()
    print(f"\n[완료] 임베딩: {stats['saved']}건 저장, {stats['skipped']}건 스킵, {stats['failed']}건 실패")


def cmd_search(args):
    """검색 테스트"""
    from rag.retriever import Retriever

    retriever = Retriever()
    result = retriever.search(
        question=args.query,
        source_filter=args.source
    )

    print(f"\n[검색] {args.query}")
    print(f"[신뢰도] {result['confidence']}")
    print(f"\n[답변]\n{result['answer']}")

    if result["sources"]:
        print("\n[출처]")
        for s in result["sources"]:
            print(f"  [{s['board_name']}] {s['title']} (score: {s['score']})")
            print(f"  -> {s['url']}")


def cmd_stats(args):
    """통계 조회"""
    import os
    import glob

    lod_path = os.getenv("DATA_LOD_PATH", "./data/lod_nexon")
    cafe_path = os.getenv("DATA_CAFE_PATH", "./data/naver_cafe")
    bookmark_path = os.getenv("DATA_BOOKMARK_PATH", "./data/bookmarks")

    lod_count = len(glob.glob(os.path.join(lod_path, "*.json")))
    cafe_count = len(glob.glob(os.path.join(cafe_path, "*.json")))
    bookmark_count = len(glob.glob(os.path.join(bookmark_path, "*.json")))

    print(f"\n[데이터 현황]")
    print(f"  LOD 공홈 원본: {lod_count}건")
    print(f"  네이버 카페 원본: {cafe_count}건")
    print(f"  책갈피: {bookmark_count}건")

    # 이미지 통계
    lod_img_count = 0
    cafe_img_count = 0
    lod_img_dir = os.path.join(lod_path, "images")
    cafe_img_dir = os.path.join(cafe_path, "images")
    if os.path.isdir(lod_img_dir):
        lod_img_count = len(os.listdir(lod_img_dir))
    if os.path.isdir(cafe_img_dir):
        cafe_img_count = len(os.listdir(cafe_img_dir))
    if lod_img_count or cafe_img_count:
        print(f"\n[이미지]")
        print(f"  LOD 이미지 폴더: {lod_img_count}개 게시글")
        print(f"  카페 이미지 폴더: {cafe_img_count}개 게시글")

    try:
        from rag.embedder import Embedder
        embedder = Embedder()
        qdrant_stats = embedder.get_stats()
        print(f"\n[Qdrant]")
        print(f"  전체 벡터: {qdrant_stats['total_bookmarks']}건")
        print(f"  LOD: {qdrant_stats['lod_nexon']}건")
        print(f"  카페: {qdrant_stats['naver_cafe']}건")
    except Exception as e:
        print(f"\n[경고] Qdrant 연결 실패: {e}")


def main():
    parser = argparse.ArgumentParser(description="LOD RAG Server CLI")
    subparsers = parser.add_subparsers(dest="command", help="사용 가능한 명령")

    # crawl-lod
    p_lod = subparsers.add_parser("crawl-lod", help="LOD 공홈 크롤링")
    p_lod.add_argument("--pages", type=int, default=20, help="크롤링할 페이지 수 (기본: 20)")
    p_lod.set_defaults(func=cmd_crawl_lod)

    # crawl-cafe
    p_cafe = subparsers.add_parser("crawl-cafe", help="네이버 카페 크롤링")
    p_cafe.add_argument("--pages", type=int, default=10, help="게시판당 크롤링 페이지 수 (기본: 10)")
    p_cafe.set_defaults(func=cmd_crawl_cafe)

    # create-bookmarks
    p_bm = subparsers.add_parser("create-bookmarks", help="책갈피 생성 (GPT)")
    p_bm.set_defaults(func=cmd_create_bookmarks)

    # embed-all
    p_embed = subparsers.add_parser("embed-all", help="전체 임베딩 → Qdrant")
    p_embed.set_defaults(func=cmd_embed_all)

    # search
    p_search = subparsers.add_parser("search", help="검색 테스트")
    p_search.add_argument("query", help="검색어")
    p_search.add_argument("--source", choices=["lod_nexon", "naver_cafe"], default=None,
                          help="소스 필터")
    p_search.set_defaults(func=cmd_search)

    # stats
    p_stats = subparsers.add_parser("stats", help="데이터 통계")
    p_stats.set_defaults(func=cmd_stats)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
