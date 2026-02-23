"""
기존 Chrome 브라우저 프로필에서 네이버 쿠키를 가져와 Playwright 형식으로 저장.
Chrome에서 이미 네이버에 로그인된 상태여야 합니다.

사용법: python save_cookies_chrome.py
"""

import time
from playwright.sync_api import sync_playwright
import os


def get_chrome_user_data_dir():
    """Chrome 기본 프로필 경로"""
    return os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")


def main():
    chrome_dir = get_chrome_user_data_dir()
    if not os.path.isdir(chrome_dir):
        print(f"[ERROR] Chrome profile not found: {chrome_dir}")
        return

    print(f"Chrome profile: {chrome_dir}")
    print("Using existing Chrome login session...")
    print()
    print("[!] Chrome must be completely closed before running this script!")
    print()

    with sync_playwright() as p:
        # 기존 Chrome 프로필을 사용하여 브라우저 실행
        context = p.chromium.launch_persistent_context(
            user_data_dir=chrome_dir,
            channel="chrome",
            headless=False,
            args=["--profile-directory=Default"]
        )

        page = context.new_page()

        # 네이버 카페 접속
        page.goto("https://cafe.naver.com", wait_until="domcontentloaded", timeout=15000)
        time.sleep(3)

        # 로그인 상태 확인
        login_btn = page.query_selector("#gnb_login_button")

        if login_btn:
            print("[FAIL] Chrome is not logged in to Naver.")
            print("       Open Chrome, log in to naver.com, then try again.")
        else:
            print("[OK] Naver login confirmed!")
            # Playwright 호환 쿠키 저장
            context.storage_state(path="naver_cookies.json")
            print("[OK] naver_cookies.json saved successfully!")

        context.close()


if __name__ == "__main__":
    main()
