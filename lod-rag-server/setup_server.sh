#!/bin/bash
# LOD RAG Server 서버 초기 설치 스크립트 (Ubuntu/Debian)

set -e

echo "=== LOD RAG Server 초기 설치 ==="
echo

# 1. Python 3.11+ 확인
echo "[1/5] Python 버전 확인..."
python3 --version || {
    echo "Python 3.11+ 필요. 설치 중..."
    sudo apt-get update
    sudo apt-get install -y python3.11 python3.11-venv python3-pip
}

# 2. pip 의존성 설치
echo "[2/5] Python 의존성 설치..."
pip install -r requirements.txt

# 3. Playwright + Chromium 설치
echo "[3/5] Playwright Chromium 설치..."
playwright install chromium
playwright install-deps chromium

# 추가 시스템 의존성 (Playwright가 누락할 수 있는 것들)
sudo apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    2>/dev/null || true

# 4. 데이터 디렉토리 생성
echo "[4/5] 데이터 디렉토리 생성..."
mkdir -p data/lod_nexon data/naver_cafe data/bookmarks

# 5. 환경변수 설정
echo "[5/5] 환경변수 설정..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "⚠️  .env 파일이 생성되었습니다. OPENAI_API_KEY 등을 설정하세요:"
    echo "    nano .env"
else
    echo ".env 파일이 이미 존재합니다."
fi

echo
echo "=== 설치 완료 ==="
echo
echo "다음 단계:"
echo "  1. .env 파일에 OPENAI_API_KEY 설정"
echo "  2. Qdrant 실행:"
echo "     docker run -d --name qdrant -p 6333:6333 -v ~/wikibot-data/qdrant:/qdrant/storage qdrant/qdrant"
echo "  3. 네이버 쿠키 업로드 (로컬 PC에서):"
echo "     scp naver_cookies.json user@서버IP:$(pwd)/"
echo "  4. 초기 크롤링:"
echo "     python main.py crawl-lod"
echo "     python main.py create-bookmarks"
echo "     python main.py embed-all"
echo "  5. 서버 실행:"
echo "     uvicorn app:app --host 0.0.0.0 --port 8100"
echo
