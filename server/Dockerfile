# Build context: repository root (Coolify: Dockerfile location = /server/Dockerfile)

# --- web app (Vite SPA) ---
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY worker/package.json worker/
COPY cli/package.json cli/
COPY web/package.json web/
RUN npm ci -w web --include-workspace-root=false
COPY web/ web/
RUN npm run build -w web

# --- server ---
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY worker/package.json worker/
COPY cli/package.json cli/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --include-workspace-root=false && npm cache clean --force
COPY server/ server/
COPY --from=web /app/web/dist web/dist
WORKDIR /app/server
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
