# Serves the Break Monitor web SPA and API.
# Railway / Render / Fly / Azure inject PORT and env vars at runtime.
FROM node:20-alpine
WORKDIR /app
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server/standalone.js"]
