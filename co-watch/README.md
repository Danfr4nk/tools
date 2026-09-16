# CO-WATCH

Watch something *with* Sammy. He can't see video — but he can read a timed
transcript and talk about it with you in real time while you watch.

**The protocol (all in chat):**

1. You send Sammy a YouTube link.
2. He pulls the timed transcript, adds it to `transcripts.json`, pushes.
3. You open this page, pick the video, hit play.
4. You talk to Sammy live in chat — drop a timestamp (`@ 4:32`) when you
   want him at an exact moment, react whenever. He follows along in the
   transcript and answers from that exact point.

**On the page:**

- Video + transcript side by side. The current line highlights as it plays
  and auto-scrolls.
- Click any transcript line to seek the video there.
- The **ping Sammy** button on each line copies a chat-ready message
  (`co-watch <id> @ M:SS — `) — paste it into chat and finish the thought.
- Videos Sammy has loaded show up as chips under the URL bar. A link with
  no transcript yet tells you to send it to him first.

**Adding a transcript:** entries in `transcripts.json` are keyed by the
11-char YouTube video id:

```json
{
  "KbTvUOx2A6c": {
    "title": "Video Title",
    "lines": [ { "t": 0.0, "text": "first line" }, ... ]
  }
}
```

`t` is seconds (float). Sammy populates this whenever you send him a link.
