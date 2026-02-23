#!/bin/bash
# wikibot-kakao 자동 배포 스크립트 (docker-compose)
# 사용법: ./deploy.sh [--force]
#   --force: 변경 감지 없이 강제 배포 (GitHub Actions용)
#   기본: cron으로 주기적 실행, 변경 있을 때만 빌드/재시작

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO_DIR="$HOME/wikibot-kakao"
DATA_DIR="$HOME/wikibot-data"
ENV_FILE="$DATA_DIR/.env"
LOG_FILE="$REPO_DIR/deploy.log"
FORCE_DEPLOY=false

# --force 옵션 체크
if [ "$1" = "--force" ]; then
    FORCE_DEPLOY=true
fi

cd "$REPO_DIR" || exit 1

# 최신 변경사항 가져오기
git fetch origin master 2>/dev/null

# 로컬과 원격 비교 (--force가 아닐 때만)
if [ "$FORCE_DEPLOY" = false ]; then
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/master)

    if [ "$LOCAL" = "$REMOTE" ]; then
        exit 0
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 변경 감지: $LOCAL -> $REMOTE" >> "$LOG_FILE"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 강제 배포 시작 (--force)" >> "$LOG_FILE"
fi

# data 디렉토리 보장
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/qdrant"
mkdir -p "$DATA_DIR/rag_data/lod_nexon"
mkdir -p "$DATA_DIR/rag_data/naver_cafe"
mkdir -p "$DATA_DIR/rag_data/bookmarks"

# 기존 repo 내 DB 파일 → data 디렉토리로 마이그레이션 (1회성)
for db in nickname.db notice.db trade.db party.db; do
    if [ -f "$REPO_DIR/$db" ] && [ ! -f "$DATA_DIR/$db" ]; then
        cp "$REPO_DIR/$db" "$DATA_DIR/$db"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] DB 마이그레이션: $db → $DATA_DIR/" >> "$LOG_FILE"
    fi
done

# feature-toggles.json → data 디렉토리로 마이그레이션 (1회성)
if [ ! -f "$DATA_DIR/feature-toggles.json" ]; then
    docker cp wikibot-server:/app/feature-toggles.json "$DATA_DIR/feature-toggles.json" 2>/dev/null
    if [ -f "$DATA_DIR/feature-toggles.json" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] feature-toggles.json 마이그레이션 완료" >> "$LOG_FILE"
    fi
fi

# pull + submodule update
git pull origin master >> "$LOG_FILE" 2>&1
git submodule update --init --recursive >> "$LOG_FILE" 2>&1

# DB 파일이 없으면 생성 (디렉토리가 아닌 파일로)
for db in nickname.db notice.db trade.db party.db; do
    if [ ! -f "$DATA_DIR/$db" ]; then
        touch "$DATA_DIR/$db"
    fi
done

# feature-toggles.json 없으면 기본값 생성
if [ ! -f "$DATA_DIR/feature-toggles.json" ]; then
    echo '{}' > "$DATA_DIR/feature-toggles.json"
fi

# 배포 전 DB 백업 (0바이트가 아닌 경우만)
BACKUP_DIR="$DATA_DIR/backup"
mkdir -p "$BACKUP_DIR"
for db in nickname.db notice.db trade.db party.db; do
    if [ -s "$DATA_DIR/$db" ]; then
        cp "$DATA_DIR/$db" "$BACKUP_DIR/${db}.bak"
    fi
done

# docker-compose 빌드 & 배포
export DATA_DIR
docker compose -f "$REPO_DIR/docker-compose.yml" build >> "$LOG_FILE" 2>&1

if [ $? -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 빌드 실패" >> "$LOG_FILE"
    exit 1
fi

docker compose -f "$REPO_DIR/docker-compose.yml" up -d >> "$LOG_FILE" 2>&1

# iris-bot 코드 동기화 + 재시작
IRIS_DIR="$HOME/iris-kakao-bot"
if [ -d "$IRIS_DIR" ]; then
    cp "$REPO_DIR/iris-kakao-bot/app.py" "$IRIS_DIR/bot-server/app.py" 2>/dev/null
    docker exec iris-bot-server rm -rf /app/__pycache__ 2>/dev/null
    docker restart iris-bot-server >> "$LOG_FILE" 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] iris-bot 동기화 완료" >> "$LOG_FILE"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 배포 완료: $(git rev-parse --short HEAD)" >> "$LOG_FILE"
