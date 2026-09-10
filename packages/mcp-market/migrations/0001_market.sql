-- Minimal Market catalogue: Admin-curated NPM exact versions.
-- NPM remains the source of truth for packages, versions, dist-tags and artifacts.
-- This schema stores only the publication decision and its immutable snapshot.

-- Foreign keys are resolved lazily by SQLite, so market_packages may reference
-- market_publications declared below it. Triggers are parsed eagerly, so every
-- trigger is declared only after all tables it reads exist.

CREATE TABLE market_packages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  latest_publication_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, package_name),
  -- Composite self-reference guarantees the pointer can only ever name a
  -- publication of this same package, not merely any publication id.
  FOREIGN KEY (latest_publication_id, id)
    REFERENCES market_publications (id, package_id)
);

CREATE TABLE market_publications (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES market_packages (id),
  exact_version TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  metadata_digest TEXT NOT NULL,
  first_published_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  unpublished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, exact_version),
  UNIQUE (id, package_id),
  CHECK (published_at >= first_published_at)
);

CREATE INDEX market_publications_visible
  ON market_publications (package_id, unpublished_at, published_at DESC, id DESC);

-- Market latest must always name a currently visible publication of this package.
CREATE TRIGGER market_latest_visible_insert
BEFORE INSERT ON market_packages
WHEN NEW.latest_publication_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM market_publications
    WHERE id = NEW.latest_publication_id
      AND package_id = NEW.id
      AND unpublished_at IS NULL
  ) THEN RAISE(ABORT, 'latest publication must be visible') END;
END;

CREATE TRIGGER market_latest_visible_update
BEFORE UPDATE OF latest_publication_id ON market_packages
WHEN NEW.latest_publication_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM market_publications
    WHERE id = NEW.latest_publication_id
      AND package_id = NEW.id
      AND unpublished_at IS NULL
  ) THEN RAISE(ABORT, 'latest publication must be visible') END;
END;

-- Reverse direction: a publication may not be hidden while some package still
-- points at it as latest. Callers must move the pointer first.
CREATE TRIGGER market_publication_visible_update
BEFORE UPDATE OF unpublished_at ON market_publications
WHEN NEW.unpublished_at IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM market_packages
    WHERE latest_publication_id = NEW.id
  ) THEN RAISE(ABORT, 'cannot hide the current latest publication') END;
END;

CREATE TABLE admin_operations (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'unpublish')),
  package_id TEXT NOT NULL REFERENCES market_packages (id),
  publication_id TEXT NOT NULL REFERENCES market_publications (id),
  occurred_at TEXT NOT NULL,
  request_id TEXT NOT NULL
);

CREATE INDEX admin_operations_occurred_at ON admin_operations (occurred_at DESC);

-- Operational record of static page regeneration. Not part of the publication
-- state machine.
CREATE TABLE public_refresh_attempts (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES market_packages (id),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  error_code TEXT,
  request_id TEXT NOT NULL
);

CREATE INDEX public_refresh_attempts_package
  ON public_refresh_attempts (package_id, requested_at DESC);

-- Rebuildable technical search index. Holds one row per package, always copied
-- from the current latest snapshot; it is never a source of business fact.
CREATE VIRTUAL TABLE market_search USING fts5 (
  package_id UNINDEXED,
  package_name,
  display_name,
  summary,
  description,
  keywords,
  agents,
  servers,
  tokenize = 'unicode61 remove_diacritics 2'
);
