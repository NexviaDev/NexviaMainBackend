나라장터 입찰공고 API 서버 (구 bid_backend)

[실행]
cd backend
cp .env.example .env
npm install
npm start

기본 포트: 5001 (backend/.env 의 PORT)

[프론트 연동]
frontend 개발 서버(3001)가 /api 를 localhost:5001 로 프록시합니다.
입찰 UI: frontend/bidding/ — 빌드 시 dist/bidding/
