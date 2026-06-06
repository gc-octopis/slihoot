* Replace brand Text with Logo. [100%]
* Take Header outside of main tag and have a full width. [100%]
* add fullscreen presentation
* add alarm

# Below is a prompt used for updating frontend:

1. make the header looks more natural.

* The logo and Text are both 80% height and centered. [100%]
* The header is always shown on the top, no matter the scrolling. [100%]
* The logo will change to the version without the text part when screen width is too small. [100%]
* Prevent broken when there are too many header actions, by turning them into a dropdown (only when needed, when there are enough space, keep it as it is)

2. In admin live page, add a fullscreen presentation mode.

* the presentation-stage or result-panel should be the main thing shown when fullscreen. status-row and button-row should be redesign to a smaller size and only show on hover (mouse moving).
* fix the bug where some pages of pdf sometimes doesn't fully loaded onto the canvas.
* There should be an option of fullscreen on current screen, or open a new window which could be displayed on another screen (or maybe captured by obs) while admin (presenter) could still control / view everything on the standard live page. (this means when pages are changed in the live page, the fullscreen page should sync).
* In the original live page and fullscreen view, add hotkey for changing page (including pgUp/pgDn, up/down, left/right), but don't fire when typing (e.g. in the Q&A section) [100%]
* When Q&A is minimized, or in fullscreen mode, if someone left a new message, show it on screen as a small bubble in the bottom right corner, including the message and the author, for a few seconds before fades away. [100%]

3. Update the Activity experience.

* If an activity has time limit, and the previous viewing page (not guaranteed to be page - 1) isn't a time limit activity (or is a pdf view), make it so that before the event started, add a waiting page showing the current activity's type (like 選擇題、文字雲 etc.), only when start button (or enter key) is pressed, it starts the activity and start countdown.
* fix the bug where an activity without time limit shows times up when move to another page then move back again. It should always accept answers as as long as its page is showing.
* add a button for resetting an activity, which resets countdown to max, and all answers are cleared. Reset required confirming.
* In music.json, there is a category called game, when a time limit activity starts, randomly pick a song in the category and play, the song should stop when time's up.

The structure is `Record<string, string[]>`, the key string is the category name, the string array is the list of files.

4. Add Alarm

* In Event Editor page, add an option to add multiple alarms in the event. when setting alarm, admin can choose a song listed in the music.json bell category and there is a play button where they can listen to it while choosing.
* If that event has a live session, play the bell song when time matches. Use an empty js worker to check current time every 500ms, so even if the presenter isn't targeting this webpage for a longtime, it'll still ring the alarm on time and won't lazy loaded. 

# And after the prompt, there are still problems that needed to be fixed:

1. 
* [No need to fix] LLM implemented the hamburger menu, but it's not showing when the width is too small. But since it's a edge case, I'll leave it there.

2. 
* Some more content is needed to be added to the fullscreen activity view. Like the choices of a multi-choice question. The result of the activity should auto show when time's up, or at least prompt the presenter decide show or not show.
    * Expected Behavior: Show the choices, description while running, show the result of the activity immediately after it ends (including answer, 詳解, chart).
* The newly designed control row is still taking some space, making the slides not fullscreen.
    * Expect Behavior: The view being fullscreen, the row overlaps with the view when displayed (with a half transparent background)
* page not loading (white screen) happens less often, but still happens changing from activity back to pdf view.
    * Expect Behavior: No more white screen when switching from any page to any other page.
* The new window mode doesn't keep the session, so it brings you back to root page. (maybe required backend?)
    * Expect Behavior: The new window remembers the admin login, and directly showing a fullscreen version of the live session.
* There need to be a way to bring up Q&A menu in fullscreen mode, so more message can be viewed at once and replied.
    * Expect Behavior: Add a button in control row that when clicked also brings up the Q&A chat box.

3. 
* The waiting page is implemented but not shown when using.
    * Expect Behavior: When switched to a time limit activity, it actually show the waiting page first, before entering the activity and start playing song.
* activity without time limit still shows time's up when switch back to the page for the second time. (maybe required backend?)
    * Expect Behavior: That activity should be able to answer again whenever that page is showing, no matter how many times the page has shown before.
* Reset seems to require some API, so currently not working.
    * Expect Behavior: No more error alert box. And actually rest the activity, if it's a time limit one, goes back to the waiting page; if it's not, directly start it again.
* [No more action required] music files are located in root (/public) not (/public/music), I've manually changed that.
* song not playing if 2 time limit activities are in a row.
    * Expect Behavior: Song should play normally when switching between. A new song should be picked after the switch.
* sometimes song starts playing again after the activity is ended but travel to that page again.
    * Expect Behavior: Song never starts, if the activity is over.

4. 
* Saving alarm must required backend (so it doesn't work by just updating frontend)
    * Expect Behavior: Alarm should be saved into the database correctly and played correctly when in a live session.
