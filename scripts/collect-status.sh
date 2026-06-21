#!/bin/bash
# 관리페이지 서비스 상태 수집기
# host에서 docker/systemctl/adb 상태를 모아 src/system-status.json 으로 떨군다.
# wikibot 컨테이너가 bind-mount된 /app/src 에서 이 파일을 읽어 /api/system/status 로 제공.
# cron(매분) 또는 수동 실행. src/ 는 정적 서빙 대상이 아니므로 외부 노출 안 됨.

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

OUT="/home/ubuntu/wikibot-kakao/src/system-status.json"
TMP="${OUT}.tmp"

# JSON 문자열 escape (따옴표/백슬래시)
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# 도커 컨테이너 상태: {"name","ok","detail"}
docker_json() {
  local name="$1" line running status ok
  line="$(docker ps -a --filter "name=^${name}\$" --format '{{.State}}|{{.Status}}' 2>/dev/null | head -1)"
  if [ -z "$line" ]; then
    printf '{"name":"%s","ok":false,"detail":"없음"}' "$(esc "$name")"
    return
  fi
  running="${line%%|*}"
  status="${line#*|}"
  ok=false
  [ "$running" = "running" ] && ok=true
  printf '{"name":"%s","ok":%s,"detail":"%s"}' "$(esc "$name")" "$ok" "$(esc "$status")"
}

# systemd 서비스 상태
svc_json() {
  local name="$1" st ok
  st="$(systemctl is-active "$name" 2>/dev/null)"
  [ -z "$st" ] && st="unknown"
  ok=false
  [ "$st" = "active" ] && ok=true
  printf '{"name":"%s","ok":%s,"detail":"%s"}' "$(esc "$name")" "$ok" "$(esc "$st")"
}

# redroid adb 연결
adb_state="$(adb devices 2>/dev/null | awk '/5555/{print $2}' | head -1)"
adb_ok=false
[ "$adb_state" = "device" ] && adb_ok=true
[ -z "$adb_state" ] && adb_state="offline"

ts="$(date '+%Y-%m-%d %H:%M:%S')"

{
  printf '{\n'
  printf '  "collected_at": "%s",\n' "$ts"
  printf '  "containers": [%s, %s],\n' "$(docker_json wikibot-server)" "$(docker_json kakao_redroid)"
  printf '  "services": [%s, %s, %s],\n' \
    "$(svc_json iris-bot.service)" \
    "$(svc_json iris-watchdog.service)" \
    "$(svc_json cloudflared-wikibot.service)"
  printf '  "redroid_adb": {"name":"redroid adb (:5555)","ok":%s,"detail":"%s"}\n' "$adb_ok" "$(esc "$adb_state")"
  printf '}\n'
} > "$TMP" && mv "$TMP" "$OUT"
