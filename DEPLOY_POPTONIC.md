# Poptonic independent deployment

This project is deployed as an independent OCR insurance app for:

- `https://poptonic.cn`
- `https://www.poptonic.cn`
- `https://app.poptonic.cn`

For the current ECS + AutoDL production release runbook, see `docs/production-release-wiki.md`.

It must not reuse the existing `joyhive.cn` C/P/B containers or nginx server names.

## Target layout

- Source directory on ECS: `/opt/poptonic-ocr`
- Docker Compose file: `docker-compose.poptonic.yml`
- Public web bind: `127.0.0.1:5601`
- Host nginx config: `deploy/nginx/poptonic-host.conf`
- Runtime env file: `deploy/poptonic.env`

The app containers are separate from the existing insurance platform:

- `web`: serves the Vite build and proxies `/api/` to the app API
- `api`: account, policy, admin, SMS, and responsibility analysis API
- `ocr`: OCR extraction API used by `api`

## First release on ECS

```bash
sudo mkdir -p /opt/poptonic-ocr
sudo chown -R "$USER":"$USER" /opt/poptonic-ocr
cd /opt/poptonic-ocr
```

Copy this project into `/opt/poptonic-ocr`, then create the production env file:

```bash
cp deploy/poptonic.env.example deploy/poptonic.env
chmod 600 deploy/poptonic.env
vi deploy/poptonic.env
```

At minimum, fill:

- `POLICY_ADMIN_PASSWORD`
- `POLICY_OCR_SERVICE_TOKEN`
- OCR provider values, such as `POLICY_OCR_BAIDU_PRIVATE_URL`
- `DEEPSEEK_API_KEY` if responsibility analysis should use the model API
- Aliyun SMS values if real SMS login is enabled

Start the independent app:

```bash
docker compose -p poptonic-ocr -f docker-compose.poptonic.yml up -d --build
docker compose -p poptonic-ocr -f docker-compose.poptonic.yml ps
curl -fsS http://127.0.0.1:5601/health
curl -fsS http://127.0.0.1:5601/api/health
```

Install the dedicated host nginx config:

```bash
sudo cp deploy/nginx/poptonic-host.conf /etc/nginx/conf.d/poptonic-ocr.conf
sudo nginx -t
sudo systemctl reload nginx
```

Verify through the public host:

```bash
curl -fsS http://127.0.0.1/ -H 'Host: poptonic.cn' | head
curl -fsS http://127.0.0.1/api/health -H 'Host: poptonic.cn'
curl -fsS https://poptonic.cn/api/health
curl -fsS https://app.poptonic.cn/api/health
```

## DNS and TLS

Point `poptonic.cn`, `www.poptonic.cn`, and `app.poptonic.cn` to the ECS ingress or Cloudflare proxy that reaches the ECS.

If TLS terminates on Cloudflare, keep host nginx on port 80. If TLS terminates on ECS, issue certificates for all three names and add the matching `listen 443 ssl` server block without changing the upstream `127.0.0.1:5601`.

## Rollback

To roll back only Poptonic OCR, do not touch the `joyhive.cn` compose project.

```bash
cd /opt/poptonic-ocr
docker compose -p poptonic-ocr -f docker-compose.poptonic.yml down
```

If the previous project files were backed up, restore them and run:

```bash
docker compose -p poptonic-ocr -f docker-compose.poptonic.yml up -d --build
```

To disable public traffic while keeping containers running:

```bash
sudo mv /etc/nginx/conf.d/poptonic-ocr.conf /etc/nginx/conf.d/poptonic-ocr.conf.disabled
sudo nginx -t
sudo systemctl reload nginx
```
