-- HTTP 定义与 npm 共用同一条 market_packages 身份；保存定义不触发远程请求。
ALTER TABLE market_packages ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'npm'
  CHECK (source_kind IN ('npm', 'http'));
ALTER TABLE market_packages ADD COLUMN endpoint TEXT;
ALTER TABLE market_packages ADD COLUMN display_name TEXT;
ALTER TABLE market_packages ADD COLUMN http_protocol TEXT NOT NULL DEFAULT '2025'
  CHECK (http_protocol IN ('2025', '2026-07-28'));
ALTER TABLE market_packages ADD COLUMN definition_revision INTEGER NOT NULL DEFAULT 1
  CHECK (definition_revision > 0);

CREATE INDEX market_packages_source_kind
  ON market_packages (source_kind, package_name);
CREATE INDEX market_packages_http_endpoint
  ON market_packages (endpoint)
  WHERE source_kind = 'http' AND endpoint IS NOT NULL;
