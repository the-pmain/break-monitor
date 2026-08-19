# Cloud host for the HTTP server only (not Electron).
# Railway / Render / Fly will inject PORT and env vars at runtime.
FROM node:20-alpine
WORKDIR /app
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server/standalone.js"]
