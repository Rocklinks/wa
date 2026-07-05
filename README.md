---
title: Sathya Messenger
sdk: docker
---

# Sathya Messenger — Render Deploy

## Deploy steps
1. Push files to GitHub repo
2. render.com → New → Web Service → Connect GitHub repo
3. Select: **Docker** environment
4. Port: **10000**
5. Deploy → get URL → open → scan QR → done

## Notes
- Render free tier sleeps after 15min idle — wakes in ~30s on URL open
- WhatsApp session saved in /data — persists across sleeps
- SMS Gateway: tap ⚙️ in app → enter your phone IP
