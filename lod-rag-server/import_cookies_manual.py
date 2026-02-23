"""
[서버 전용] 수동 쿠키값 입력 → naver_cookies.json 변환기
로컬 PC에서 SCP가 불가능할 때 브라우저 개발자 도구에서 쿠키를 복사하여 입력

사용법:
  python import_cookies_manual.py
"""

import json


def main():
    print()
    print("=" * 50)
    print("  네이버 쿠키 수동 입력기")
    print("=" * 50)
    print()
    print("브라우저 개발자 도구(F12) → Application → Cookies 에서")
    print(".naver.com 도메인의 쿠키를 확인하세요.")
    print()

    cookies = []

    # 핵심 쿠키 목록
    required_cookies = ["NID_AUT", "NID_SES", "NID_JKL"]
    optional_cookies = ["NACT", "nid_inf"]

    print("--- 필수 쿠키 ---")
    for name in required_cookies:
        value = input(f"  {name} = ").strip()
        if value:
            cookies.append({
                "name": name,
                "value": value,
                "domain": ".naver.com",
                "path": "/",
                "httpOnly": True,
                "secure": True,
                "sameSite": "None"
            })
        else:
            print(f"  ⚠️ {name} 비어있음 (로그인 실패 가능)")

    print()
    print("--- 선택 쿠키 (Enter로 건너뛰기) ---")
    for name in optional_cookies:
        value = input(f"  {name} = ").strip()
        if value:
            cookies.append({
                "name": name,
                "value": value,
                "domain": ".naver.com",
                "path": "/",
                "httpOnly": True,
                "secure": True,
                "sameSite": "None"
            })

    # Playwright storage_state 형식으로 저장
    storage_state = {
        "cookies": cookies,
        "origins": []
    }

    with open("naver_cookies.json", "w", encoding="utf-8") as f:
        json.dump(storage_state, f, ensure_ascii=False, indent=2)

    print()
    print(f"✅ naver_cookies.json 저장 완료 (쿠키 {len(cookies)}개)")
    print()


if __name__ == "__main__":
    main()
