'use strict';
const FIRST_DELAY = 5000;
const MAX_DELAY = 24 * 60 * 60 * 1000;

class PhoneRecoveryLog {
  constructor(store) {
    this.store = store;
    // All paths that restore normal operation publish one of these receipts.
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS clear_resolved_phone_retries
      AFTER INSERT ON events WHEN NEW.type IN ('device.recovered','device.connection_verified','device.presence')
      AND EXISTS (SELECT 1 FROM devices WHERE id=json_extract(NEW.payload,'$.device_id')
                  AND kind='android' AND quarantined=0 AND health='ready' AND faults='{}')
      BEGIN
        DELETE FROM events WHERE type IN ('device.repair_started','device.repair_failed')
          AND json_extract(payload,'$.device_id')=json_extract(NEW.payload,'$.device_id');
      END`);
  }
  schedule(id) {
    const db = this.store.db;
    let incident = db.prepare(`SELECT seq,created,type,json_extract(payload,'$.reason') reason FROM events
      WHERE json_extract(payload,'$.device_id')=? AND request_id IS NULL
      AND type IN ('device.quarantined','lease.expired','device.recovered') ORDER BY seq DESC LIMIT 1`).get(id);
    if (!incident || incident.type === 'device.recovered') {
      // An older isolation without a timestamp is already due.
      incident = {seq:0, created:0, reason:'DEVICE_QUARANTINED'};
    }
    const latest = db.prepare(`SELECT payload FROM events WHERE json_extract(payload,'$.device_id')=?
      AND seq>? AND type IN ('device.repair_started','device.repair_failed')
      AND json_extract(payload,'$.quarantine_seq')=? ORDER BY seq DESC LIMIT 1`).get(id, incident.seq, incident.seq);
    const prior = latest && JSON.parse(latest.payload);
    return {incident:incident.seq, reason:incident.reason || 'LEASE_EXPIRED', attempts:prior?.attempt || 0,
      next:prior?.next_retry_at ?? incident.created + FIRST_DELAY};
  }
  start(id, manual, schedule) {
    const attempt = schedule ? schedule.attempts + 1 : null;
    const delay = schedule ? Math.min(MAX_DELAY, FIRST_DELAY * 2 ** Math.min(attempt, 15)) : null;
    const entry = {device_id:id, manual, attempt, quarantine_seq:schedule?.incident ?? null, delay_ms:delay,
      next_retry_at:delay === null ? null : this.store.now() + delay};
    this.store.event(null,'device.repair_started',entry);
    return entry;
  }
  failed(entry, code, next) {
    const next_retry_at = entry.delay_ms === null ? next : this.store.now() + entry.delay_ms;
    this.store.event(null,'device.repair_failed',{...entry, code, next_retry_at});
  }
  view(device, running, offlineRetry) {
    const isolated = Boolean(device.quarantined);
    const problem = isolated || device.health !== 'ready' || Object.keys(device.faults).length ||
      ['offline','unauthorized'].includes(device.connection_state) || device.last_error;
    if (!problem) return null;
    const schedule = isolated ? this.schedule(device.id) : null;
    const rows = this.store.db.prepare(`SELECT seq,created,type,payload FROM events WHERE json_extract(payload,'$.device_id')=?
      AND seq>coalesce((SELECT max(seq) FROM events WHERE json_extract(payload,'$.device_id')=? AND
        (type='device.recovered' OR (type='device.connection_verified' AND json_extract(payload,'$.healthy')=1))),0)
      AND type IN ('device.quarantined','unit.failed','lease.expired','device.repair_started','device.repair_failed','device.presence','device.connection_verified')
      AND (type!='lease.expired' OR request_id IS NULL) ORDER BY seq DESC LIMIT 50`).all(device.id,device.id);
    const history = rows.map(row => {
      const p = JSON.parse(row.payload);
      return {seq:row.seq, at:row.created, type:row.type, code:p.code || p.reason ||
        (row.type==='lease.expired'?'LEASE_EXPIRED':row.type==='device.presence'?p.health:null),
        manual:p.manual, attempt:p.attempt, next_retry_at:p.next_retry_at};
    });
    return {reason:schedule?.reason || device.last_error || Object.values(device.faults)[0] ||
      (device.connection_state==='unauthorized'?'ADB_AUTHORIZATION_REQUIRED':device.connection_state==='offline'?'PHONE_OFFLINE':device.health==='disconnected'?'PHONE_NOT_DETECTED':device.health),
      running, next_retry_at:running ? null : schedule?.next ?? offlineRetry, history};
  }
}
module.exports = {PhoneRecoveryLog};
