-- Real members share a virtual workflow. No real finance/reputation rows are changed.
CREATE TABLE IF NOT EXISTS mission_simulations (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  solver_id TEXT NOT NULL REFERENCES users(id),
  teaser_id TEXT NOT NULL REFERENCES teasers(id),
  source_reward INTEGER NOT NULL CHECK(source_reward BETWEEN 10000 AND 100000000),
  create_request_key TEXT NOT NULL,
  start_fingerprint TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  UNIQUE(owner_id,create_request_key),
  CHECK(owner_id <> solver_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mission_simulation_one_active ON mission_simulations(challenge_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS mission_simulation_parties ON mission_simulations(owner_id,solver_id,challenge_id);
CREATE TABLE IF NOT EXISTS mission_simulation_events (
  id TEXT PRIMARY KEY,
  simulation_id TEXT NOT NULL REFERENCES mission_simulations(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  action TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(simulation_id,request_key),
  UNIQUE(simulation_id,revision)
);
CREATE TRIGGER IF NOT EXISTS mission_simulation_event_immutable_update BEFORE UPDATE ON mission_simulation_events BEGIN SELECT RAISE(ABORT,'MISSION_SIMULATION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mission_simulation_event_immutable_delete BEFORE DELETE ON mission_simulation_events BEGIN SELECT RAISE(ABORT,'MISSION_SIMULATION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mission_simulation_snapshot_immutable BEFORE UPDATE OF challenge_id,owner_id,solver_id,teaser_id,source_reward,create_request_key,start_fingerprint ON mission_simulations BEGIN SELECT RAISE(ABORT,'MISSION_SIMULATION_SNAPSHOT_IMMUTABLE'); END;
-- Release these locks by cancelling the virtual attempt; paid attempts do not prevent real progress.
CREATE TRIGGER IF NOT EXISTS mission_simulation_challenge_lock BEFORE UPDATE OF owner_id,reward_amount,selected_solver_id,status,funding_status ON challenges
WHEN (NEW.owner_id IS NOT OLD.owner_id OR NEW.reward_amount IS NOT OLD.reward_amount OR NEW.selected_solver_id IS NOT OLD.selected_solver_id OR NEW.status IS NOT OLD.status OR NEW.funding_status IS NOT OLD.funding_status)
 AND EXISTS(SELECT 1 FROM mission_simulations s JOIN users owner ON owner.id=s.owner_id WHERE s.challenge_id=OLD.id AND s.closed_at IS NULL AND owner.status='active' AND json_extract(s.state_json,'$.payoutStatus')<>'PAID')
BEGIN SELECT RAISE(ABORT,'MISSION_SIMULATION_LOCKED'); END;
CREATE TRIGGER IF NOT EXISTS mission_simulation_teaser_lock BEFORE UPDATE OF status,solver_id,challenge_id ON teasers
WHEN (NEW.status IS NOT OLD.status OR NEW.solver_id IS NOT OLD.solver_id OR NEW.challenge_id IS NOT OLD.challenge_id)
 AND EXISTS(SELECT 1 FROM mission_simulations s JOIN users owner ON owner.id=s.owner_id WHERE s.teaser_id=OLD.id AND s.closed_at IS NULL AND owner.status='active' AND json_extract(s.state_json,'$.payoutStatus')<>'PAID')
BEGIN SELECT RAISE(ABORT,'MISSION_SIMULATION_LOCKED'); END;
