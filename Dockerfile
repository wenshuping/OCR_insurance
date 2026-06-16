FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts ./scripts
COPY ocr-service ./ocr-service
COPY src/family-report-engine.mjs ./src/family-report-engine.mjs
COPY src/policy-plan-filter.mjs ./src/policy-plan-filter.mjs
COPY src/policy-validity.mjs ./src/policy-validity.mjs
RUN mkdir -p /data
EXPOSE 4206 4105
CMD ["node", "server/index.mjs"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx/ocr-web-container.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
