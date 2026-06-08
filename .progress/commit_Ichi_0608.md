## Summary

This update focuses on three larger changes:

- Fixing event alarms so they are saved and ring correctly during live sessions.
- Moving historical data export to the event list.
- Improving the event editor save flow.

## Alarm Fixes

- Fixed alarm persistence by saving event alarms to the database.
- Added an `alarms_json` column through migration `0004_event_alarms.sql`.
- Event create/update APIs now save alarm settings.
- Live session state now includes alarm settings so the host page can schedule them.
- Fixed the live alarm worker so it reads the latest alarm data when the scheduled time arrives.

## Export Historical Data

- Moved historical data export from the host live page to each event card in the event list.
- Export is only available after an event has been started before and is currently ended.
- Added backend validation so inactive/unfinished event history cannot be exported through the API directly.
- Export still supports Excel, JSON, and CSV.

## Event Editor Save Flow

- `Save Event` now responds to broader editor changes, not only title and description.
- Changes to event settings, alarm settings, question drafts, PDF import/removal, question deletion, and question ordering now make the save button available.
- If a question draft has been edited, pressing `Save Event` saves that question before returning to the event list.
- Leaving the editor with an unsaved question draft now shows a warning.


## Notes for Teammates

- Existing databases need the new migration before alarm persistence works.