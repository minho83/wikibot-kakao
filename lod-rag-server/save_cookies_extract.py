"""
Chrome 쿠키 DB에서 네이버 쿠키를 복호화하여 Playwright 형식으로 저장.
Chrome이 완전히 닫혀있어야 합니다.

pip install pycryptodome
"""

import base64
import json
import os
import shutil
import sqlite3

# Windows DPAPI
import ctypes
import ctypes.wintypes


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def dpapi_decrypt(encrypted):
    """Windows DPAPI로 복호화"""
    blob_in = DATA_BLOB(len(encrypted), ctypes.create_string_buffer(encrypted, len(encrypted)))
    blob_out = DATA_BLOB()

    if ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
        return data
    return None


def get_chrome_key():
    """Chrome Local State에서 암호화 키 추출"""
    local_state_path = os.path.expandvars(
        r"%LOCALAPPDATA%\Google\Chrome\User Data\Local State"
    )
    with open(local_state_path, "r", encoding="utf-8") as f:
        local_state = json.load(f)

    encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
    # 앞 5바이트 "DPAPI" 접두사 제거
    encrypted_key = encrypted_key[5:]
    return dpapi_decrypt(encrypted_key)


def decrypt_cookie_value(encrypted_value, key):
    """Chrome v80+ AES-GCM 쿠키 복호화"""
    if not encrypted_value:
        return ""

    # v10/v20 접두사 확인
    if encrypted_value[:3] == b"v10" or encrypted_value[:3] == b"v20":
        nonce = encrypted_value[3:15]
        ciphertext = encrypted_value[15:]

        from Crypto.Cipher import AES
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        try:
            return cipher.decrypt_and_verify(ciphertext[:-16], ciphertext[-16:]).decode("utf-8")
        except Exception:
            return ""
    else:
        # 구버전: DPAPI 직접 복호화
        decrypted = dpapi_decrypt(encrypted_value)
        return decrypted.decode("utf-8") if decrypted else ""


def main():
    print("Chrome cookie decryptor")
    print("(Chrome must be completely closed!)")
    print()

    cookies_db = os.path.expandvars(
        r"%LOCALAPPDATA%\Google\Chrome\User Data\Default\Network\Cookies"
    )
    if not os.path.exists(cookies_db):
        print(f"[ERROR] Cookies DB not found: {cookies_db}")
        return

    # Chrome 암호화 키 추출
    try:
        key = get_chrome_key()
        if not key:
            print("[ERROR] Failed to decrypt Chrome key")
            return
        print("[OK] Chrome encryption key extracted")
    except Exception as e:
        print(f"[ERROR] Key extraction failed: {e}")
        return

    # DB 복사 (잠금 방지)
    tmp_db = "cookies_tmp.db"
    shutil.copy2(cookies_db, tmp_db)

    try:
        conn = sqlite3.connect(tmp_db)
        cursor = conn.cursor()

        cursor.execute("""
            SELECT name, value, encrypted_value, host_key, path,
                   expires_utc, is_secure, is_httponly, samesite
            FROM cookies
            WHERE host_key LIKE '%naver.com%'
        """)

        cookies = []
        for row in cursor.fetchall():
            name, value, enc_value, domain, path, expires, secure, httponly, samesite = row

            # value가 비어있으면 encrypted_value 복호화
            if not value and enc_value:
                value = decrypt_cookie_value(enc_value, key)

            if not value:
                continue

            same_site_map = {-1: "None", 0: "None", 1: "Lax", 2: "Strict"}

            cookies.append({
                "name": name,
                "value": value,
                "domain": domain,
                "path": path,
                "expires": expires / 1000000 - 11644473600 if expires > 0 else -1,
                "httpOnly": bool(httponly),
                "secure": bool(secure),
                "sameSite": same_site_map.get(samesite, "Lax")
            })

        conn.close()

    finally:
        if os.path.exists(tmp_db):
            os.remove(tmp_db)

    if not cookies:
        print("[ERROR] No Naver cookies found")
        return

    # 주요 쿠키 확인
    cookie_names = {c["name"] for c in cookies}
    has_aut = "NID_AUT" in cookie_names
    has_ses = "NID_SES" in cookie_names

    print(f"Extracted {len(cookies)} cookies")
    print(f"NID_AUT: {'OK' if has_aut else 'MISSING'}")
    print(f"NID_SES: {'OK' if has_ses else 'MISSING'}")

    if not has_aut or not has_ses:
        print()
        print("[WARN] Login cookies missing. Are you logged in to Naver in Chrome?")

    # Playwright storage_state 형식으로 저장
    storage_state = {
        "cookies": cookies,
        "origins": []
    }

    with open("naver_cookies.json", "w", encoding="utf-8") as f:
        json.dump(storage_state, f, ensure_ascii=False, indent=2)

    print()
    print("[OK] naver_cookies.json saved!")


if __name__ == "__main__":
    main()
