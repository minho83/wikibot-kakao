FROM python:3.11-slim

WORKDIR /app

# 시스템 의존성
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Playwright Chromium 의존성 수동 설치 (Debian trixie 호환)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-unifont \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxrandr2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/* \
    && playwright install chromium

COPY . .

# data 디렉토리 생성 (볼륨 마운트 전 기본 구조)
RUN mkdir -p data/lod_nexon/images data/naver_cafe/images data/bookmarks

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8100/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
