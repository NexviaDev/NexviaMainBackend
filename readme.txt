나라장터 입찰공고 API 서버 (구 bid_backend)

[실행]
cd backend
cp .env.example .env
npm install

# 권장 (npm이 로컬 nodemon을 PATH에 넣음)
npm start
# 또는
npm run dev

# 전역 nodemon (bare `nodemon` 이 PATH 에 없을 때) — Agent Shell 말고 더블클릭:
#   install-nodemon-global.bat
# 또는 cmd:  python scripts\_install_nodemon_global.py

# Git Bash 만 (전역 npm 없이 ~/bin 링크, 1회):
bash ./install-gitbash-nodemon.sh
# → 새 Git Bash 를 연 뒤 backend/ 에서:
nodemon app.js

# 대안 (설치 없이 현재 셸만)
source ./use-local-bin.sh
nodemon app.js
# 또는
npx nodemon app.js
# 또는 (cmd.exe)
nodemon.cmd app.js

기본 포트: 5001 (backend/.env 의 PORT)

[프론트 연동]
frontend 개발 서버(3001)가 /api 를 localhost:5001 로 프록시합니다.
입찰 UI: frontend/bidding/ — 빌드 시 dist/bidding/
