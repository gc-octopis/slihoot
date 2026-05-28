In this commit, I added some music into the repo.  

To match the vibe of Kahoot, some background music is needed. It'll also be used in time alert.

The music files are all in public folder with ogg format to lower the file size, and are tracked by git LFS.  

Musics are not under MIT License, the ones created by Kevin Macleod are under CC BY 4.0, and the credit is added in `README.MD`, the ones created by gcoctopis are licensed under TBD (maybe CC BY or proprietary).

`public/music.json` listed all the file names of ogg files, and marked with multiple categories for different usage. The structure is `Record<string, string[]>`, the key string is the category name, the string array is the list of files.