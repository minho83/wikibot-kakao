FROM python:3.11-slim

WORKDIR /app

# 시스템 의존성 (Playwright headless용)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Playwright Chromium 설치 (폰트 패키지 수동 설치 후 의존성)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-unifont fonts-ubuntu \
    && rm -rf /var/lib/apt/lists/* \
    && playwright install chromium \
    && playwright install-deps chromium || true

COPY . .

# data 디렉토리 생성 (볼륨 마운트 전 기본 구조)
RUN mkdir -p data/lod_nexon/images data/naver_cafe/images data/bookmarks

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8100/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
