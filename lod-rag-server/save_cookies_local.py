"""
[로컬 PC 전용] 네이버 쿠키 저장 스크립트
브라우저에서 직접 로그인 후 쿠키를 naver_cookies.json으로 저장

사용법:
  pip install playwright
  playwright install chromium
  python save_cookies_local.py

저장 후:
  scp naver_cookies.json user@서버IP:프로젝트경로/lod-rag-server/
"""

from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        page.goto("https://nid.naver.com/nidlogin.login")

        print()
        print("=" * 50)
        print("  네이버 로그인 페이지가 열렸습니다.")
        print("  브라우저에서 로그인해주세요.")
        print("  (로그인 상태 유지 체크 권장)")
        print("=" * 50)
        print()

        input("로그인 완료 후 Enter 키를 누르세요: ")

        # 쿠키 + 로컬스토리지 전체 저장
        context.storage_state(path="naver_cookies.json")

        print()
        print("✅ naver_cookies.json 저장 완료!")
        print()
        print("서버에 업로드:")
        print("  scp naver_cookies.json user@서버IP:프로젝트경로/lod-rag-server/")
        print()

        browser.close()


if __name__ == "__main__":
    main()
