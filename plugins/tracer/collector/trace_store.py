from __future__ import annotations
import json
import sqlite3
import threading
import time
from pathlib import Path

DDL = """
CREATE TABLE IF NOT EXISTS runs(
  epoch TEXT PRIMARY KEY,
  candidate_id TEXT,
  parent_id TEXT,
  fingerprint TEXT,
  started_at REAL,
  finished_at REAL,
  status TEXT
);
CREATE TABLE IF NOT EXISTS traces(
  epoch TEXT,
  session TEXT,
  seq INTEGER,
  kind TEXT,
  payload TEXT,
  ingested_at REAL,
  event_id TEXT,
  PRIMARY KEY(epoch, session, seq)
);
CREATE TABLE IF NOT EXISTS outcomes(
  epoch TEXT,
  task_id TEXT,
  success INTEGER,
  reward REAL,
  latency_ms REAL,
  cost_usd REAL,
  recorded_at REAL,
  attempt_id TEXT,
  payload TEXT,
  PRIMARY KEY(epoch, task_id)
);
CREATE TABLE IF NOT EXISTS sessions(
  epoch TEXT,
  session TEXT,
  kind TEXT,
  count INTEGER,
  first_at REAL,
  updated_at REAL,
  stats TEXT,
  PRIMARY KEY(epoch, session)
);
CREATE TABLE IF NOT EXISTS events(
  epoch TEXT,
  attempt TEXT,
  seq INTEGER,
  type TEXT,
  at TEXT,
  payload TEXT,
  ingested_at REAL,
  PRIMARY KEY(epoch, attempt, seq)
);
CREATE TABLE IF NOT EXISTS feedback(
  epoch TEXT PRIMARY KEY,
  payload TEXT,
  generated_at REAL
);
CREATE TABLE IF NOT EXISTS analyses(
  epoch TEXT,
  digest_hash TEXT,
  model TEXT,
  scope TEXT NOT NULL DEFAULT 'epoch',
  payload TEXT,
  generated_at REAL,
  PRIMARY KEY(epoch, digest_hash, model, scope)
);
CREATE TABLE IF NOT EXISTS experience(
  pattern_key TEXT,
  change TEXT,
  delta TEXT,
  n_samples INTEGER,
  updated_at REAL,
  PRIMARY KEY(pattern_key, change)
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_traces_epoch ON traces(epoch);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON events(epoch, attempt);
CREATE INDEX IF NOT EXISTS idx_outcomes_epoch ON outcomes(epoch);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_analyses_epoch ON analyses(epoch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_event
  ON traces(epoch, event_id) WHERE event_id IS NOT NULL;
"""

# Columns added after the first release; created on demand for existing databases.
ADDED_COLUMNS = {
    "traces": {"event_id": "TEXT"},
    "runs": {"status": "TEXT", "finished_at": "REAL", "artifacts": "TEXT", "config": "TEXT"},
    "outcomes": {"attempt_id": "TEXT", "payload": "TEXT"},
}

class Store:
    def __init__(self, path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._auto = 0
        with self._lock:
            self._db.executescript("PRAGMA journal_mode=WAL;" + DDL)
            self._add_missing_columns()
            self._db.executescript(INDEXES)
            self._db.commit()

    def _add_missing_columns(self):
        for table, columns in ADDED_COLUMNS.items():
            existing = {row[1] for row in self._db.execute("PRAGMA table_info(%s)" % table)}
            for name, kind in columns.items():
                if name not in existing:
                    self._db.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, name, kind))

    def close(self):
        with self._lock:
            self._db.close()

    def upsert_run(self, epoch, candidate_id=None, parent_id=None, fingerprint=None,
                   config=None):
        fp = json.dumps(fingerprint, ensure_ascii=False) if fingerprint is not None else None
        cfg = json.dumps(config, ensure_ascii=False) if isinstance(config, dict) else None
        with self._lock:
            self._db.execute(
                "INSERT INTO runs(epoch,candidate_id,parent_id,fingerprint,config,started_at,status) "
                "VALUES(?,?,?,?,?,?,'running') "
                "ON CONFLICT(epoch) DO UPDATE SET "
                "candidate_id=COALESCE(excluded.candidate_id,candidate_id),"
                "parent_id=COALESCE(excluded.parent_id,parent_id),"
                "fingerprint=COALESCE(excluded.fingerprint,fingerprint),"
                "config=COALESCE(excluded.config,config)",
                (epoch, candidate_id, parent_id, fp, cfg, time.time()))
            self._db.commit()

    def set_parent(self, epoch, parent_id):
        """Overwrite parent_id directly: COALESCE in upsert_run can only fill, never clear, so unlinking needs this."""
        with self._lock:
            self._db.execute("UPDATE runs SET parent_id=? WHERE epoch=?", (parent_id, epoch))
            self._db.commit()

    def set_artifacts(self, epoch, artifacts):
        """Record where deterministic results were written so the panel can show the saved location."""
        with self._lock:
            self._db.execute("UPDATE runs SET artifacts=? WHERE epoch=?",
                             (json.dumps(artifacts, ensure_ascii=False), epoch))
            self._db.commit()

    def finish_run(self, epoch):
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO runs(epoch,finished_at,status) VALUES(?,?,'finished') "
                "ON CONFLICT(epoch) DO UPDATE SET "
                "status='finished', "
                "finished_at=COALESCE(runs.finished_at,excluded.finished_at)",
                (epoch, now))
            self._db.commit()
        return self.get_run(epoch)

    def get_run(self, epoch):
        with self._lock:
            row = self._db.execute("SELECT * FROM runs WHERE epoch=?", (epoch,)).fetchone()
        return dict(row) if row else None

    def find_run_by_candidate(self, candidate_id, exclude_epoch=None):
        sql = "SELECT * FROM runs WHERE candidate_id=?"
        args = [candidate_id]
        if exclude_epoch:
            sql += " AND epoch<>?"
            args.append(exclude_epoch)
        sql += " ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 1"
        with self._lock:
            row = self._db.execute(sql, args).fetchone()
        return dict(row) if row else None

    def add_trace(self, epoch, session, seq, kind, payload, event_id=None):
        if seq is None:
            self._auto += 1
            seq = int(time.time() * 1000) * 1000 + self._auto % 1000
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO traces(epoch,session,seq,kind,payload,ingested_at,event_id) "
                "VALUES(?,?,?,?,?,?,?)",
                (epoch, session, int(seq), kind, json.dumps(payload, ensure_ascii=False),
                 time.time(), event_id))
            self._db.commit()
        return cur.rowcount > 0

    def put_trace(self, epoch, session, seq, kind, payload):
        """Write or overwrite a rebuilt trace; returns whether it was inserted for the first time.

        The same attempt is rebuilt incrementally from events; later results overwrite earlier ones without double counting.
        """
        with self._lock:
            exists = self._db.execute(
                "SELECT 1 FROM traces WHERE epoch=? AND session=? AND seq=?",
                (epoch, session, int(seq))).fetchone() is not None
            self._db.execute(
                "INSERT INTO traces(epoch,session,seq,kind,payload,ingested_at,event_id) "
                "VALUES(?,?,?,?,?,?,NULL) "
                "ON CONFLICT(epoch,session,seq) DO UPDATE SET "
                "kind=excluded.kind, payload=excluded.payload, ingested_at=excluded.ingested_at",
                (epoch, session, int(seq), kind, json.dumps(payload, ensure_ascii=False),
                 time.time()))
            self._db.commit()
        return not exists

    def add_event(self, epoch, attempt, seq, typ, at, payload):
        """Store one raw event row; only the first row per (epoch, attempt, seq) is kept."""
        if seq is None:
            self._auto += 1
            seq = self._auto
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO events(epoch,attempt,seq,type,at,payload,ingested_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (epoch, attempt, int(seq), typ, at,
                 json.dumps(payload, ensure_ascii=False), time.time()))
            self._db.commit()
        return cur.rowcount > 0

    def list_events(self, epoch, attempt):
        with self._lock:
            rows = self._db.execute(
                "SELECT payload FROM events WHERE epoch=? AND attempt=? ORDER BY seq",
                (epoch, attempt)).fetchall()
        return [json.loads(r["payload"]) for r in rows]

    def touch_session(self, epoch, session, kind, stats=None, bump=True):
        stats_json = (json.dumps(stats, ensure_ascii=False, separators=(",", ":"))
                      if stats is not None else None)
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO sessions(epoch,session,kind,count,first_at,updated_at,stats) "
                "VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(epoch,session) DO UPDATE SET "
                "kind=CASE "
                "  WHEN excluded.kind='trajectory' THEN 'trajectory' "
                "  WHEN sessions.kind IS NULL OR sessions.kind='unknown' THEN excluded.kind "
                "  ELSE sessions.kind END, "
                "count=sessions.count+?, "
                "updated_at=excluded.updated_at, "
                "stats=COALESCE(excluded.stats, sessions.stats)",
                (epoch, session, kind or "unknown", 1 if bump else 0, now, now, stats_json,
                 1 if bump else 0))
            self._db.commit()

    @staticmethod
    def _session_row(row):
        d = dict(row)
        d["stats"] = json.loads(d["stats"]) if d.get("stats") else None
        return d

    def list_sessions(self, epoch=None):
        sql = ("SELECT epoch,session,kind,count,first_at,updated_at,stats "
               "FROM sessions")
        args = ()
        if epoch:
            sql += " WHERE epoch=?"
            args = (epoch,)
        sql += " ORDER BY updated_at DESC"
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [self._session_row(r) for r in rows]

    def get_session(self, epoch, session):
        with self._lock:
            row = self._db.execute(
                "SELECT epoch,session,kind,count,first_at,updated_at,stats "
                "FROM sessions WHERE epoch=? AND session=?", (epoch, session)).fetchone()
        return self._session_row(row) if row else None

    def latest_session_epoch(self, session):
        with self._lock:
            row = self._db.execute(
                "SELECT epoch FROM sessions WHERE session=? "
                "ORDER BY updated_at DESC LIMIT 1", (session,)).fetchone()
        return row["epoch"] if row else None

    def delete_session(self, session, epoch=None):
        with self._lock:
            if epoch:
                self._db.execute("DELETE FROM sessions WHERE session=? AND epoch=?",
                                 (session, epoch))
            else:
                self._db.execute("DELETE FROM sessions WHERE session=?", (session,))
            self._db.commit()

    def add_outcome(self, epoch, data):
        task_id = str(data.get("task_id") or data.get("taskId") or "")
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO outcomes(epoch,task_id,success,reward,latency_ms,cost_usd,"
                "recorded_at,attempt_id,payload) VALUES(?,?,?,?,?,?,?,?,?)",
                (epoch, task_id, 1 if data.get("success") else 0, data.get("reward"),
                 data.get("latency_ms", data.get("latencyMs")),
                 data.get("cost_usd", data.get("costUsd")), time.time(),
                 str(data.get("attempt_id") or ""),
                 json.dumps(data, ensure_ascii=False)))
            self._db.commit()

    def get_outcome(self, epoch, attempt_id):
        """Find an outcome by attempt to attach scoring details to trajectory-level analysis."""
        if not attempt_id:
            return None
        with self._lock:
            row = self._db.execute(
                "SELECT payload FROM outcomes WHERE epoch=? AND attempt_id=? LIMIT 1",
                (epoch, str(attempt_id))).fetchone()
        return json.loads(row["payload"]) if row and row["payload"] else None

    def list_traces(self, epoch, session=None, limit=None, offset=0):
        sql = "SELECT session,seq,kind,payload FROM traces WHERE epoch=?"
        args = [epoch]
        if session:
            sql += " AND session=?"
            args.append(session)
        sql += " ORDER BY ingested_at,seq"
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            args.extend((int(limit), int(offset)))
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [{"session": r["session"], "seq": r["seq"], "kind": r["kind"],
                 "payload": json.loads(r["payload"])} for r in rows]

    def replay_traces(self, session=None, epoch=None, limit=2000):
        sql = "SELECT epoch,session,seq,kind,payload FROM traces"
        where, args = [], []
        if epoch:
            where.append("epoch=?")
            args.append(epoch)
        if session:
            where.append("session=?")
            args.append(session)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY ingested_at DESC, seq DESC LIMIT ?"
        args.append(int(limit))
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        rows = list(reversed(rows))
        return [{"epoch": r["epoch"], "session": r["session"], "seq": r["seq"],
                 "kind": r["kind"], "payload": json.loads(r["payload"])} for r in rows]

    def count_traces(self, epoch, session=None):
        sql = "SELECT COUNT(*) FROM traces WHERE epoch=?"
        args = [epoch]
        if session:
            sql += " AND session=?"
            args.append(session)
        with self._lock:
            return int(self._db.execute(sql, args).fetchone()[0])

    def list_outcomes(self, epoch):
        with self._lock:
            rows = self._db.execute("SELECT * FROM outcomes WHERE epoch=?", (epoch,)).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            raw = item.pop("payload", None)
            if raw:
                try:
                    merged = json.loads(raw)
                    if isinstance(merged, dict):
                        item.update({k: v for k, v in merged.items() if k not in item})
                except ValueError:
                    pass
            items.append(item)
        return items

    def save_feedback(self, epoch, payload):
        with self._lock:
            self._db.execute(
                "INSERT INTO feedback(epoch,payload,generated_at) VALUES(?,?,?) "
                "ON CONFLICT(epoch) DO UPDATE SET payload=excluded.payload,generated_at=excluded.generated_at",
                (epoch, json.dumps(payload, ensure_ascii=False), time.time()))
            self._db.commit()

    def get_feedback(self, epoch):
        with self._lock:
            row = self._db.execute("SELECT payload FROM feedback WHERE epoch=?", (epoch,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def save_analysis(self, epoch, digest_hash, model, payload, scope="epoch"):
        """Store an LLM analysis keyed by input digest, model and scope."""
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO analyses(epoch,digest_hash,model,scope,payload,"
                "generated_at) VALUES(?,?,?,?,?,?)",
                (epoch, digest_hash, model, scope,
                 json.dumps(payload, ensure_ascii=False), time.time()))
            self._db.commit()

    def get_analysis(self, epoch, digest_hash, model, scope="epoch"):
        with self._lock:
            row = self._db.execute(
                "SELECT payload FROM analyses WHERE epoch=? AND digest_hash=? AND model=? "
                "AND scope=?",
                (epoch, digest_hash, model, scope)).fetchone()
        return json.loads(row["payload"]) if row else None

    def get_latest_analysis(self, epoch):
        with self._lock:
            row = self._db.execute(
                "SELECT payload FROM analyses WHERE epoch=? AND scope='epoch' "
                "ORDER BY generated_at DESC LIMIT 1", (epoch,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def latest_epoch(self):
        rows = self.list_epochs()
        return rows[0]["epoch"] if rows else None

    def list_epochs(self):
        with self._lock:
            rows = self._db.execute(
                "WITH epochs AS ("
                "  SELECT epoch FROM runs"
                "  UNION SELECT epoch FROM traces"
                "  UNION SELECT epoch FROM outcomes"
                "  UNION SELECT epoch FROM events"
                ") "
                "SELECT e.epoch,r.candidate_id,r.parent_id,r.started_at,"
                "COALESCE(r.status,'unknown') AS status,r.finished_at,"
                "(SELECT COUNT(*) FROM traces t WHERE t.epoch=e.epoch) AS traces,"
                "(SELECT COUNT(*) FROM outcomes o WHERE o.epoch=e.epoch) AS outcomes,"
                "COALESCE(r.started_at,"
                "  (SELECT MAX(ingested_at) FROM traces t WHERE t.epoch=e.epoch),"
                "  (SELECT MAX(ingested_at) FROM events ev WHERE ev.epoch=e.epoch),"
                "  (SELECT MAX(recorded_at) FROM outcomes o WHERE o.epoch=e.epoch),0) AS last_at "
                "FROM epochs e LEFT JOIN runs r ON r.epoch=e.epoch "
                "ORDER BY last_at DESC").fetchall()
        return [dict(r) for r in rows]

    def delete_epoch(self, epoch):
        with self._lock:
            for t in ("traces", "outcomes", "sessions", "feedback", "events", "analyses"):
                self._db.execute("DELETE FROM " + t + " WHERE epoch=?", (epoch,))
            self._db.execute("DELETE FROM runs WHERE epoch=?", (epoch,))
            self._db.commit()
        return True

    def stale_epochs(self, cutoff_ts):
        """Return epochs whose last activity is older than cutoff_ts.

        Epochs still marked running are never treated as stale.
        """
        with self._lock:
            rows = self._db.execute(
                "WITH epochs AS ("
                "  SELECT epoch FROM runs"
                "  UNION SELECT epoch FROM traces"
                "  UNION SELECT epoch FROM outcomes"
                "  UNION SELECT epoch FROM events"
                ") "
                "SELECT e.epoch, COALESCE(r.status,'unknown') AS status, "
                "MAX(COALESCE(r.finished_at,0),"
                "  COALESCE((SELECT MAX(ingested_at) FROM traces t WHERE t.epoch=e.epoch),0),"
                "  COALESCE((SELECT MAX(ingested_at) FROM events ev WHERE ev.epoch=e.epoch),0),"
                "  COALESCE((SELECT MAX(recorded_at) FROM outcomes o WHERE o.epoch=e.epoch),0),"
                "  COALESCE(r.started_at,0)) AS last_at "
                "FROM epochs e LEFT JOIN runs r ON r.epoch=e.epoch").fetchall()
        return [r["epoch"] for r in rows
                if r["last_at"] < cutoff_ts and r["status"] != "running"]

    def purge_older_than(self, cutoff_ts):
        epochs = self.stale_epochs(cutoff_ts)
        for ep in epochs:
            self.delete_epoch(ep)
        return epochs

    def purge(self, vacuum=True):
        with self._lock:
            for t in ("traces", "outcomes", "sessions", "feedback", "runs", "experience", "events"):
                self._db.execute("DELETE FROM " + t)
            self._db.commit()
            if vacuum:
                self._db.execute("VACUUM")
        return True
