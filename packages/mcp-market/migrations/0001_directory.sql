CREATE TABLE backend_registries (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  website_url TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE publishers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX api_keys_prefix ON api_keys(key_prefix);
CREATE TABLE mcp_items (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  backend_registry_id TEXT NOT NULL REFERENCES backend_registries(id),
  display_name TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  homepage_url TEXT,
  repository_url TEXT,
  icon_url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('pending','active','archived','suspended')),
  suspended_from_status TEXT CHECK(suspended_from_status IN ('pending','active','archived') OR suspended_from_status IS NULL),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  suspended_at TEXT
);
CREATE TABLE mcp_item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES mcp_items(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  backend_locator_json TEXT NOT NULL,
  server_definition_json TEXT NOT NULL,
  env_schema_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','published')),
  submitted_by TEXT NOT NULL REFERENCES publishers(id),
  submitted_at TEXT NOT NULL,
  published_at TEXT,
  published_by_type TEXT CHECK(published_by_type IN ('admin','publisher') OR published_by_type IS NULL),
  published_by_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(item_id,version),
  UNIQUE(id,item_id)
);
CREATE TABLE mcp_item_latest (
  item_id TEXT PRIMARY KEY REFERENCES mcp_items(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(revision_id,item_id) REFERENCES mcp_item_revisions(id,item_id)
);
CREATE TRIGGER mcp_item_latest_published_insert BEFORE INSERT ON mcp_item_latest
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM mcp_item_revisions WHERE id=NEW.revision_id AND item_id=NEW.item_id AND status='published') THEN RAISE(ABORT,'latest revision must be published') END;
END;
CREATE TRIGGER mcp_item_latest_published_update BEFORE UPDATE OF revision_id,item_id ON mcp_item_latest
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM mcp_item_revisions WHERE id=NEW.revision_id AND item_id=NEW.item_id AND status='published') THEN RAISE(ABORT,'latest revision must be published') END;
END;
CREATE TABLE item_review_events (id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES mcp_items(id) ON DELETE CASCADE,revision_id TEXT NOT NULL REFERENCES mcp_item_revisions(id) ON DELETE CASCADE,decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),actor_id TEXT NOT NULL,note TEXT,request_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE latest_revision_events (id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES mcp_items(id) ON DELETE CASCADE,old_revision_id TEXT,new_revision_id TEXT NOT NULL REFERENCES mcp_item_revisions(id),reason TEXT NOT NULL CHECK(reason IN ('initial_approval','revision_publish','publisher_rollback')),actor_type TEXT NOT NULL CHECK(actor_type IN ('admin','publisher','system')),actor_id TEXT,request_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE item_status_events (id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES mcp_items(id) ON DELETE CASCADE,from_status TEXT NOT NULL,to_status TEXT NOT NULL,actor_type TEXT NOT NULL CHECK(actor_type IN ('admin','publisher')),actor_id TEXT NOT NULL,reason TEXT,request_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE audit_logs (id TEXT PRIMARY KEY,action TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,subject_type TEXT NOT NULL,subject_id TEXT,request_id TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
