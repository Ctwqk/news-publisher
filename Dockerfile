FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY publishers ./publishers
COPY scripts ./scripts
COPY dashboard ./dashboard

ENV NODE_ENV=production

CMD ["node", "scripts/news-publisher.mjs", "--loop"]
