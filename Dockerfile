FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY index.js ./
ENV NODE_ENV=production
ENV DATA_DIR=/data
CMD ["node", "index.js"]
