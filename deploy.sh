#!/bin/bash
# wikibot-kakao 자동 배포 스크립트
# cron으로 주기적 실행: 변경 있을 때만 빌드/재시작

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO_DIR="$HOME/wikibot-kakao"
IMAGE_NAME="wikibot-kakao"
CONTAINER_NAME="wikibot-server"
ENV_FILE="$HOME/wikibot-data/.env"
LOG_FILE="$REPO_DIR/deploy.log"

# DB 파일은 repo 디렉토리에 직접 저장
DB_DIR="$REPO_DIR"

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

# DB 파일이 없으면 생성 (디렉토리가 아닌 파일로)
for db in nickname.db notice.db trade.db; do
    if [ ! -f "$DB_DIR/$db" ]; then
        touch "$DB_DIR/$db"
    fi
done

# wikibot 컨테이너 재시작 (DB + LOD_DB 볼륨 마운트)
docker stop "$CONTAINER_NAME" 2>/dev/null
sleep 2  # SIGTERM 처리 대기
docker rm "$CONTAINER_NAME" 2>/dev/null
docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p 8100:3000 \
    -v "$DB_DIR/nickname.db:/app/nickname.db" \
    -v "$DB_DIR/notice.db:/app/notice.db" \
    -v "$DB_DIR/trade.db:/app/trade.db" \
    -v "$DB_DIR/LOD_DB:/app/LOD_DB" \
    ${ENV_FILE:+--env-file "$ENV_FILE"} \
    "$IMAGE_NAME" >> "$LOG_FILE" 2>&1

# iris-bot 코드 동기화 + pycache 삭제 + 재시작
IRIS_DIR="$HOME/iris-kakao-bot"
if [ -d "$IRIS_DIR" ]; then
    cp "$REPO_DIR/iris-kakao-bot/app.py" "$IRIS_DIR/app.py" 2>/dev/null
    docker exec iris-bot-server rm -rf /app/__pycache__ 2>/dev/null
    docker restart iris-bot-server >> "$LOG_FILE" 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] iris-bot 동기화 완료" >> "$LOG_FILE"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 배포 완료: $(git rev-parse --short HEAD)" >> "$LOG_FILE"
