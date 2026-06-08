Note: This commit is after Ichi's 0608 commit.

# Goals

* Bug fix of the gc_0606 commit. [implemented]
* Add floating scoreboard in live sessions. [implemented]
* Add poll activity type. [implemented]
* Add live-session 搶答 flow with persisted/exportable records. [implemented]

# Updated Details

* Fullscreen presentation fixes:
    * Same-window fullscreen now uses the document fullscreen surface so the Q&A panel can be shown correctly.
    * While fullscreen, the collapsed/minimized Q&A toggle is hidden; the control row Q&A button is the visible entry point.
    * Fullscreen activity result panels now use dark presentation styling instead of light cards on a dark background.
    * PDF rendering resolution is capped to reduce slow/blank renders on complex pages.
* Activity behavior fixes:
    * 文字雲 is treated as a non-quiz activity: result visibility does not close answers, and it can keep accepting new words.
    * Non-quiz result controls use 顯示結果 / 隱藏結果 instead of 公布答案.
    * Quiz activities can be reopened with 繼續接受回答 after 公布答案; reopened answers are accepted but score 0.
* New scoreboard:
    * Host can open a floating scoreboard from normal mode or fullscreen.
    * The live state now sends the full leaderboard so all players can be listed.
* New poll activity:
    * Added 投票 as an activity type with choice options and no correct answer.
    * Poll responses produce result charts but never add points.
* New 搶答 flow:
    * Host can prepare/open/close/re-run 搶答 from normal mode or fullscreen.
    * Participant devices show a floating 搶答 panel, with a top-row quick button when active.
    * The click order is synchronized through live state, so popup fullscreen and normal presenter views update together.
    * 搶答 runs and click-order entries are saved and included in JSON/CSV/XLSX exports.
* New Issues follow-up:
    * 文字雲 no longer shows a misleading 作答已結束 tag while it is still accepting answers.
    * Fullscreen controls no longer include reset; they now show 顯示/隱藏結果 for non-quiz activities or 公布/隱藏答案 for quiz activities.
    * Quiz answer publishing is now visibility-based, so hiding an answer keeps submissions closed without continuing to reveal the answer.
    * PDF pages render into an offscreen canvas first, then swap into view after a successful render to reduce partial/white canvases.
    * The session 結束 action moved from the live-page button row to the header actions.
* UI Problems follow-up:
    * PDF pages now only show navigation/session utility controls, not activity answer/result controls.
    * Timed quizzes now expose 公布/隱藏答案 in fullscreen, and 公布答案 closes the quiz immediately.
    * Quiz controls use only 公布/隱藏答案, while non-quiz controls use only 顯示/隱藏結果.
    * Fullscreen answer display now depends on actual result visibility, so 隱藏答案 removes the highlighted answer/results from the presentation view.
    * 開始答題 and 繼續接受回答 now share the same control slot; it is disabled while the quiz is actively running.

# Records

## Problems after Codex's first touch

* The Q&A box is not showing in the same-window fullscreen mode, but works in the pop-up fullscreen mode.
    * Expected: Both version shows Q&A just fine. And while fullscreen, keep only the Q&A button in the control row not the original minimized Q&A button.
* Some more information is needed in fullscreen mode.
    * The current elements of activities are in light mode, but the presentation background is drak mode, make them sync.
    * 文字雲 is not a quiz, there shoudn't be 公布答案 (doesn't make sense), instead, it should be 顯示結果 and default to be true. Since it's not a quiz, no matter if the result is shown, it should always allow new answers.
    * Besides reset, there should also be a button for 繼續接受回答 after 公布答案 is clicked. (In this state, points are not added)
* some pages still shows white (especially the ones in between activities or the first 2 after.) And some pages loaded very slow if there is a lot of elements in the PDF.


## New features

* Add a show scoreboard button to have a floating element listing the current place and score (sorted) of all players.
* Similar to how 文字雲 is not a quiz, add a new type of activity that's not quiz: poll. It functions similar to 選擇題，but should not have a correct answer, and no points are added to it.
* add a function in live session called 搶答
    * it could be triggered anytime in the event by clicking the 搶答 button in both normal mode and fullscreen model.
    * When the button is pressed, show a floating element in the center titled 開始搶答 and also a floating window in player's device, having a disabled button for 搶答. When 開始搶答 is clicked, on player's device, enable the 搶答 button, and show the order of clicks on host's screen
    * Note: handle the case where live session has a pop up window and presenter is controlling via the normal view, update the fullscreen view at the same time as these things happens
    * On the host's floating element, add a re-run button and a close element button.
    * On player's floating element, add a button to minimize the element, and a button on the top row, which when pressed, while directly send a 搶答.
    * 搶答 records should also be saved and export-able.

## New Bugs

* when clicked 搶答 button, the following error shows in the Q&A window:
```
You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'rank, e.clicked_at AS clickedAt FROM quick_response_entries e INNE' at line 7
```
and now the mysql server broken.

## New Issues

* When using 文字雲, there is always a 作答已結束 tag in the middle, even though it functions fine.
* Reset button no longer need to be in fullscreen, instead, put show/hide result there.
* Show/hide result and 公布答案 are only showing one or another, for quiz activity, give only the 公布/隱藏答案 button. And also is in the place of show/hide result in the fullscreen mode.
* Sometimes, pdf is still not fully loaded. 
* The 結束 button in button row is for ending the session, thus it should be in the header bar.

## UI Problems

* for PDF slides, there shouldn't be any 公布答案 / 繼續答題 / 顯示結果 button.
* for time limit quizes，fullscreen doesn't have the 公布答案 button, it should be there, and when clicked, immediately finished that quiz even before time runs out.
* 公布答案 and 顯示結果 are still both shown in quizes, only 公布答案 should be there for quizes.
* when clicked 隱藏答案 in fullscreen mode, it still shows the answer on screen. (it should be that way for normal mode, but not fullscreen mode)
* 開始答題 and 繼續接受回答 should be the same button depending on the state. When the quiz is running, that button should be disabled.

