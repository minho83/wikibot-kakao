"""
APScheduler 기반 자동 크롤링/책갈피/임베딩 스케줄러
FastAPI lifespan에서 시작/정지
"""

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from loguru import logger

from crawler.lod_crawler import LodCrawler
from crawler.naver_cafe_crawler import NaverCafeCrawler, CookieExpiredException
from rag.bookmark_creator import BookmarkCreator
from rag.embedder import Embedder
from utils.notify import send_kakao_notify, CRAWL_COMPLETE_MSG, COOKIE_EXPIRED_MSG

scheduler = AsyncIOScheduler()


async def hourly_job():
    """매 1시간: 신규 게시글 크롤링 + 책갈피 + 임베딩"""
    logger.info("=== 시간별 크롤링 시작 ===")
    try:
        crawler = LodCrawler()
        lod_stats = crawler.crawl_new()

        # 네이버 카페 크롤링
        cafe_stats = {"new": 0}
        try:
            cafe_crawler = NaverCafeCrawler()
            cafe_stats = await cafe_crawler.crawl_new()
        except CookieExpiredException:
            logger.warning("네이버 쿠키 만료 — 카페 크롤링 스킵")
            await send_kakao_notify(COOKIE_EXPIRED_MSG)
        except FileNotFoundError:
            logger.warning("네이버 쿠키 파일 없음 — 카페 크롤링 스킵")
        except Exception as e:
            logger.error(f"카페 크롤링 실패: {e}")

        creator = BookmarkCreator()
        bm_stats = creator.create_new()

        embedder = Embedder()
        embed_stats = embedder.process_new()

        logger.info(
            f"시간별 작업 완료: LOD {lod_stats['new']}건, 카페 {cafe_stats['new']}건, "
            f"책갈피 {bm_stats['created']}건, 임베딩 {embed_stats['saved']}건"
        )
    except Exception as e:
        logger.error(f"시간별 작업 실패: {e}")


async def daily_job():
    """매일 03:00: 미처리분 전체 보정"""
    logger.info("=== 일일 보정 작업 시작 ===")
    try:
        creator = BookmarkCreator()
        bm_stats = creator.create_all()

        embedder = Embedder()
        embed_stats = embedder.process_all()

        logger.info(
            f"일일 보정 완료: 책갈피 {bm_stats['created']}건, 임베딩 {embed_stats['saved']}건"
        )
    except Exception as e:
        logger.error(f"일일 보정 작업 실패: {e}")


async def weekly_job():
    """매주 일요일 02:00: 전체 재크롤링"""
    logger.info("=== 주간 전체 크롤링 시작 ===")
    try:
        crawler = LodCrawler()
        lod_stats = crawler.crawl_all(start_page=1, end_page=20)

        # 네이버 카페 전체 크롤링
        cafe_stats = {"new": 0}
        try:
            cafe_crawler = NaverCafeCrawler()
            cafe_stats = await cafe_crawler.crawl_all_boards(pages_per_board=10)
        except CookieExpiredException:
            logger.warning("네이버 쿠키 만료 — 카페 크롤링 스킵")
            await send_kakao_notify(COOKIE_EXPIRED_MSG)
        except FileNotFoundError:
            logger.warning("네이버 쿠키 파일 없음 — 카페 크롤링 스킵")
        except Exception as e:
            logger.error(f"카페 크롤링 실패: {e}")

        creator = BookmarkCreator()
        bm_stats = creator.create_all()

        embedder = Embedder()
        embed_stats = embedder.process_all()

        msg = CRAWL_COMPLETE_MSG.format(
            lod_count=lod_stats["new"],
            cafe_count=cafe_stats["new"],
            bookmark_count=bm_stats["created"]
        )
        await send_kakao_notify(msg)

        logger.info(f"주간 크롤링 완료: LOD {lod_stats['new']}건, 카페 {cafe_stats['new']}건")
    except Exception as e:
        logger.error(f"주간 크롤링 실패: {e}")


def start_scheduler():
    """스케줄러 시작"""
    # 매 1시간
    scheduler.add_job(
        hourly_job,
        trigger=IntervalTrigger(hours=1),
        id="hourly_crawl",
        name="시간별 크롤링",
        replace_existing=True
    )

    # 매일 새벽 03:00
    scheduler.add_job(
        daily_job,
        trigger=CronTrigger(hour=3, minute=0),
        id="daily_catchup",
        name="일일 보정",
        replace_existing=True
    )

    # 매주 일요일 02:00
    scheduler.add_job(
        weekly_job,
        trigger=CronTrigger(day_of_week="sun", hour=2, minute=0),
        id="weekly_full_crawl",
        name="주간 전체 크롤링",
        replace_existing=True
    )

    scheduler.start()
    logger.info("스케줄러 시작됨")


def stop_scheduler():
    """스케줄러 정지"""
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("스케줄러 정지됨")
