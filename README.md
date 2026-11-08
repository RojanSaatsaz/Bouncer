# Bouncer

Scam-prevention agent (T-Mobile + Photon hackathon).

## Run locally
npm install
npm run dev
# open http://localhost:3000/health

## Deploy (Railway)
Push to GitHub, create a Railway project from the repo. Railway runs `npm install` then `npm start`.
Add environment variables in Railway's Variables tab (see .env.example). Never commit .env.
