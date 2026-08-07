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
RUN apk add --no-cache \
    curl \
    font-noto \
    font-noto-cjk \
    fontconfig \
    libreoffice-calc \
    libreoffice-common \
    libreoffice-impress \
    libreoffice-writer \
    poppler-utils \
    python3 \
    py3-pip \
    py3-virtualenv \
  && fc-cache -f
RUN python3 -m venv /opt/ocr-responsibility-venv \
  && /opt/ocr-responsibility-venv/bin/pip install --no-cache-dir pypdf==6.9.2
ENV PATH="/opt/ocr-responsibility-venv/bin:${PATH}"
ENV OCR_RESPONSIBILITY_PIPELINE_PYTHON=/opt/ocr-responsibility-venv/bin/python3
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts ./scripts
COPY ocr-service ./ocr-service
COPY src/family-report-engine.mjs ./src/family-report-engine.mjs
COPY src/indicator-calculation.mjs ./src/indicator-calculation.mjs
COPY src/policy-plan-filter.mjs ./src/policy-plan-filter.mjs
COPY src/policy-validity.mjs ./src/policy-validity.mjs
COPY .agents/skills/ocr-insurance-product-responsibility-pipeline ./.agents/skills/ocr-insurance-product-responsibility-pipeline
COPY .agents/skills/ocr-insurance-accident-responsibility ./.agents/skills/ocr-insurance-accident-responsibility
COPY .agents/skills/ocr-insurance-annuity-responsibility ./.agents/skills/ocr-insurance-annuity-responsibility
COPY .agents/skills/ocr-insurance-critical-illness-responsibility ./.agents/skills/ocr-insurance-critical-illness-responsibility
COPY .agents/skills/ocr-insurance-endowment-responsibility ./.agents/skills/ocr-insurance-endowment-responsibility
COPY .agents/skills/ocr-insurance-incremental-whole-life-responsibility ./.agents/skills/ocr-insurance-incremental-whole-life-responsibility
COPY .agents/skills/ocr-insurance-long-term-care-responsibility ./.agents/skills/ocr-insurance-long-term-care-responsibility
COPY .agents/skills/ocr-insurance-medical-health-responsibility ./.agents/skills/ocr-insurance-medical-health-responsibility
COPY .agents/skills/ocr-insurance-term-life-responsibility ./.agents/skills/ocr-insurance-term-life-responsibility
COPY .agents/skills/ocr-insurance-unified-responsibility-parser ./.agents/skills/ocr-insurance-unified-responsibility-parser
COPY .agents/skills/ocr-insurance-universal-account-responsibility ./.agents/skills/ocr-insurance-universal-account-responsibility
RUN mkdir -p /data
EXPOSE 4206 4105
CMD ["node", "server/index.mjs"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx/ocr-web-container.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
