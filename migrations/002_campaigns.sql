CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE memberships (
  actor_id TEXT NOT NULL REFERENCES actors(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('editor', 'publisher', 'viewer')),
  PRIMARY KEY (actor_id, workspace_id)
);
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE campaign_versions (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  version INTEGER NOT NULL,
  goal TEXT NOT NULL, facts TEXT NOT NULL, tone TEXT NOT NULL, draft TEXT NOT NULL,
  saved_by TEXT NOT NULL REFERENCES actors(id),
  saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, version)
);
CREATE TABLE reviews (
  campaign_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, version),
  FOREIGN KEY (campaign_id, version) REFERENCES campaign_versions(campaign_id, version)
);
CREATE TABLE publications (
  id INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  snapshot TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, version),
  FOREIGN KEY (campaign_id, version) REFERENCES reviews(campaign_id, version)
);
