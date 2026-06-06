ALTER TABLE live_messages
  MODIFY COLUMN participant_id VARCHAR(36) NULL;

ALTER TABLE live_messages
  ADD COLUMN sender_name VARCHAR(80) NULL AFTER participant_id;
