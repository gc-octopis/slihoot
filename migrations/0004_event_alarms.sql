-- 0004_event_alarms: persist event-level bell alarms.

ALTER TABLE events
  ADD COLUMN alarms_json JSON NULL AFTER description;
