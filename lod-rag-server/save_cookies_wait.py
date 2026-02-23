"""
Playwright 브라우저로 네이버 로그인 후 쿠키 저장.
브라우저 창이 열리면 직접 로그인하세요.
로그인 완료 후 자동 감지하여 저장합니다 (5분 대기).
"""

import time
import sys
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            slow_mo=100,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--window-size=1024,768"
            ]
        )
        context = browser.new_context(
            viewport={"width": 1024, "height": 768},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        # 자동화 감지 방지
        page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)

        page.goto("https://nid.naver.com/nidlogin.login?url=https://cafe.naver.com")

        sys.stdout.write("\n")
        sys.stdout.write("=" * 60 + "\n")
        sys.stdout.write("  Browser window opened!\n")
        sys.stdout.write("  Please log in to Naver.\n")
        sys.stdout.write("  Waiting for login (up to 5 minutes)...\n")
        sys.stdout.write("=" * 60 + "\n")
        sys.stdout.write("\n")
        sys.stdout.flush()

        # 로그인 완료 대기
        logged_in = False
        for i in range(300):
            time.sleep(1)
            if i % 15 == 0 and i > 0:
                sys.stdout.write(f"  ... still waiting ({i}s)\n")
                sys.stdout.flush()
            try:
                url = page.url
                # 로그인 성공 시 카페 등으로 리다이렉트
                if "nid.naver.com" not in url:
                    sys.stdout.write(f"  Login detected! -> {url[:50]}\n")
                    sys.stdout.flush()
                    logged_in = True
                    time.sleep(3)
                    break
            except Exception:
                pass

        if not logged_in:
            sys.stdout.write("  Timeout reached.\n")
            sys.stdout.flush()

        # 카페 접속 확인
        try:
            page.goto("https://cafe.naver.com", wait_until="domcontentloaded", timeout=15000)
            time.sleep(3)
        except Exception:
            pass

        # 로그인 상태 검증
        login_btn = page.query_selector("#gnb_login_button")

        # 쿠키 저장
        context.storage_state(path="naver_cookies.json")

        if login_btn:
            sys.stdout.write("\n[FAIL] Not logged in.\n\n")
        else:
            sys.stdout.write("\n[OK] naver_cookies.json saved!\n\n")
        sys.stdout.flush()

        browser.close()


if __name__ == "__main__":
    main()
