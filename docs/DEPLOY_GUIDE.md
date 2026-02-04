# GitHub Actions 자동 배포 설정 가이드

## 1. 서버 준비

### PM2 설치 (프로세스 관리)
```bash
npm install -g pm2
cd ~/wikibot
pm2 start src/index.js --name wikibot
pm2 save
pm2 startup  # 부팅 시 자동 시작
```

## 2. SSH 키 생성 (서버에서)
```bash
ssh-keygen -t ed25519 -C "github-actions"
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/id_ed25519  # 이 내용을 GitHub Secret에 등록
```

## 3. GitHub Secrets 설정

GitHub 저장소 → Settings → Secrets and variables → Actions → New repository secret

| Secret 이름 | 값 |
|------------|-----|
| `SERVER_HOST` | 서버 IP 또는 도메인 |
| `SERVER_USER` | SSH 접속 계정 (예: ubuntu, root) |
| `SSH_PRIVATE_KEY` | SSH 개인키 전체 내용 (id_ed25519) |
| `SERVER_PORT` | SSH 포트 (기본 22면 생략 가능) |

## 4. GitHub Actions 워크플로우

`.github/workflows/deploy.yml` 파일 생성:

```yaml
name: Deploy to Server

on:
  push:
    branches: [master]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          port: ${{ secrets.SERVER_PORT || 22 }}
          script: |
            cd ~/wikibot
            git pull origin master
            npm install --production
            pm2 restart wikibot || pm2 start src/index.js --name wikibot
```

## 5. 테스트

1. 위 설정 완료 후 master 브랜치에 push
2. GitHub → Actions 탭에서 워크플로우 실행 확인
3. 서버에서 `pm2 logs wikibot`으로 로그 확인

## 참고: Docker 사용 시

Dockerfile이 이미 있으므로 Docker 기반 배포도 가능:

```yaml
# deploy.yml (Docker 버전)
script: |
  cd ~/wikibot
  git pull origin master
  docker build -t wikibot .
  docker stop wikibot || true
  docker rm wikibot || true
  docker run -d --name wikibot -p 3000:3000 --env-file .env wikibot
```
