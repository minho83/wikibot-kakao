#!/bin/bash
# wikibot-kakao 자동 배포 스크립트
# cron으로 주기적 실행: 변경 있을 때만 빌드/재시작

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO_DIR="$HOME/wikibot-kakao"
IMAGE_NAME="wikibot-kakao"
CONTAINER_NAME="wikibot-server"
DATA_DIR="$HOME/wikibot-data"
ENV_FILE="$HOME/wikibot-data/.env"
LOG_FILE="$REPO_DIR/deploy.log"

cd "$REPO_DIR" || exit 1

# 최신 변경사항 가져오기
git fetch origin master 2>/dev/null

# 로컬과 원격 비교
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

# 변경 있으면 배포 시작
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 변경 감지: $LOCAL -> $REMOTE" >> "$LOG_FILE"

# pull
git pull origin master >> "$LOG_FILE" 2>&1

# Docker 이미지 빌드
docker build -t "$IMAGE_NAME" . >> "$LOG_FILE" 2>&1

if [ $? -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 빌드 실패" >> "$LOG_FILE"
    exit 1
fi

# DB 데이터 디렉토리 생성
mkdir -p "$DATA_DIR"

# 컨테이너 재시작 (DB 볼륨 마운트)
docker stop "$CONTAINER_NAME" 2>/dev/null
docker rm "$CONTAINER_NAME" 2>/dev/null
docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p 8100:3000 \
    -v "$DATA_DIR/nickname.db:/app/nickname.db" \
    -v "$DATA_DIR/notice.db:/app/notice.db" \
    ${ENV_FILE:+--env-file "$ENV_FILE"} \
    "$IMAGE_NAME" >> "$LOG_FILE" 2>&1

# iris-bot 코드도 동기화
cp "$REPO_DIR/iris-kakao-bot/app.py" "$HOME/iris-kakao-bot/bot-server/app.py" 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 배포 완료: $(git rev-parse --short HEAD)" >> "$LOG_FILE"
