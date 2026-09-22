ALTER TABLE campaigns ADD COLUMN brief_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN draft_brief_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN active_generation_id TEXT;
ALTER TABLE campaign_versions ADD COLUMN brief_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_versions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_versions ADD COLUMN draft_brief_revision INTEGER NOT NULL DEFAULT 0;

-- Derive independent revision counters without renumbering campaign history.
WITH differences AS (
  SELECT campaign_id, version,
    CASE WHEN row_number() OVER w = 1 OR goal IS NOT lag(goal) OVER w
      OR facts IS NOT lag(facts) OVER w OR tone IS NOT lag(tone) OVER w THEN 1 ELSE 0 END AS brief_changed,
    CASE WHEN draft != coalesce(lag(draft) OVER w, '') THEN 1 ELSE 0 END AS draft_changed
  FROM campaign_versions WINDOW w AS (PARTITION BY campaign_id ORDER BY version)
), revisions AS (
  SELECT *, sum(brief_changed) OVER w AS br, sum(draft_changed) OVER w AS dr
  FROM differences WINDOW w AS (PARTITION BY campaign_id ORDER BY version)
), provenance AS (
  SELECT *, coalesce(max(CASE WHEN draft_changed = 1 THEN br END) OVER
    (PARTITION BY campaign_id ORDER BY version), 0) AS source_br
  FROM revisions
)
UPDATE campaign_versions AS v SET
  (brief_revision, draft_revision, draft_brief_revision) =
  (SELECT br, dr, source_br FROM provenance p WHERE p.campaign_id = v.campaign_id AND p.version = v.version);
UPDATE campaigns AS c SET (brief_revision, draft_revision, draft_brief_revision) =
  (SELECT brief_revision, draft_revision, draft_brief_revision FROM campaign_versions v
    WHERE v.campaign_id = c.id AND v.version = c.version);

CREATE TRIGGER snapshot_revisions AFTER INSERT ON campaign_versions BEGIN
  UPDATE campaign_versions SET
    brief_revision = (SELECT brief_revision FROM campaigns WHERE id = NEW.campaign_id) +
      CASE WHEN NOT EXISTS (SELECT 1 FROM campaign_versions WHERE campaign_id = NEW.campaign_id AND version < NEW.version)
        OR EXISTS (SELECT 1 FROM campaign_versions WHERE campaign_id = NEW.campaign_id
          AND version = (SELECT max(version) FROM campaign_versions WHERE campaign_id = NEW.campaign_id AND version < NEW.version)
          AND (goal != NEW.goal OR facts != NEW.facts OR tone != NEW.tone)) THEN 1 ELSE 0 END,
    draft_revision = (SELECT draft_revision FROM campaigns WHERE id = NEW.campaign_id) +
      CASE WHEN NEW.draft != coalesce((SELECT draft FROM campaign_versions WHERE campaign_id = NEW.campaign_id
        AND version < NEW.version ORDER BY version DESC LIMIT 1), '') THEN 1 ELSE 0 END
    WHERE campaign_id = NEW.campaign_id AND version = NEW.version;
  UPDATE campaign_versions SET draft_brief_revision =
    CASE WHEN draft_revision > (SELECT draft_revision FROM campaigns WHERE id = NEW.campaign_id)
      THEN brief_revision ELSE (SELECT draft_brief_revision FROM campaigns WHERE id = NEW.campaign_id) END
    WHERE campaign_id = NEW.campaign_id AND version = NEW.version;
  UPDATE campaigns SET (brief_revision, draft_revision, draft_brief_revision) =
    (SELECT brief_revision, draft_revision, draft_brief_revision FROM campaign_versions
      WHERE campaign_id = NEW.campaign_id AND version = NEW.version) WHERE id = NEW.campaign_id;
END;

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_by TEXT NOT NULL REFERENCES actors(id),
  request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  brief_snapshot TEXT NOT NULL,
  brief_revision INTEGER NOT NULL,
  base_draft_revision INTEGER NOT NULL,
  scenario TEXT NOT NULL CHECK (scenario IN ('success','delayed_success','timeout','malformed','transient_then_ok')),
  released INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retrying','succeeded','failed','obsolete')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  deadline_at INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  result_draft TEXT,
  applied_version INTEGER,
  UNIQUE(workspace_id, campaign_id, request_key)
);
CREATE UNIQUE INDEX one_active_generation ON generation_jobs(campaign_id)
  WHERE status IN ('queued','running','retrying');
CREATE TABLE generation_outbox (
  job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE generation_attempts (
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL,
  PRIMARY KEY(job_id, attempt)
);
CREATE TABLE generation_scenarios (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  scenario TEXT NOT NULL CHECK (scenario IN ('success','delayed_success','timeout','malformed','transient_then_ok'))
);
CREATE INDEX generation_pending_work ON generation_outbox(done, available_at, lease_until);
CREATE INDEX generation_campaign_history ON generation_jobs(campaign_id, created_at DESC);
