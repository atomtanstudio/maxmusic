# The one-line backend fix: let the model set the length

**What is wrong:** the ComfyUI workflow asks MiniMax Music 3 how long the song
should be, and then throws the answer away.

`MiniMaxMusic3TextEncode` has two outputs, `CONDITIONING` and `seconds`, and its
`max_duration` input is documented in the node itself as *"Maximum duration in
seconds; **the model can end the song earlier**."* So the model reads the lyrics,
plans an arrangement, and reports the length that arrangement needs. The
workflow ignores that second output and builds the audio canvas at whatever
length was requested instead:

```js
'6': {
  class_type: 'EmptyMiniMaxMusic3LatentAudio',
  inputs: {
    seconds: duration,      // ← the request, not the plan
    batch_size: 1,
  },
},
```

Plan longer than the canvas → the song is **cut off mid-phrase**. Plan shorter
than the canvas → the model fills the gap by **looping its last hook**. Both
symptoms, one cause.

## The change

`local-comfy.js`, in the workflow builder (around line 168):

```diff
   '6': {
     class_type: 'EmptyMiniMaxMusic3LatentAudio',
     inputs: {
-      seconds: duration,
+      // The model has already read the lyrics and decided how long this song
+      // is; node 4's second output is that decision. `max_duration` above
+      // stays as the ceiling the customer asked for.
+      seconds: ['4', 1],
       batch_size: 1,
     },
   },
```

Leave `max_duration: duration` on node `'4'` exactly as it is. It becomes what
it was always meant to be: a ceiling, not a target.

## Where to make it

`~/Documents/coding/legion/maxmusic` on the Mac is the development copy — the
backend that actually answers on `192.168.1.100:3010` runs from
**`/srv/ai/maxmusic` on LEGION** (the tower with the 5090), as the systemd unit
`maxmusic.service`. Editing the Mac copy changes nothing on its own.

```bash
ssh 192.168.1.100 'cd /srv/ai/maxmusic && cp local-comfy.js local-comfy.js.bak && sed -i "s/seconds: duration,/seconds: [\"4\", 1],/" local-comfy.js && node --check local-comfy.js && grep -n "seconds:" local-comfy.js'
```

`seconds: duration` appears exactly once in that file, and the backup sits
beside it. Then restart — this needs the sudo password, so it is a hands-on
step:

```bash
ssh -t 192.168.1.100 'sudo systemctl restart maxmusic'
```

Confirm it took, after making one song:

```bash
node render/check-workflow.mjs
```

## The evidence

Measured on this machine against the live ComfyUI, same 399-word lyric sheet,
same seed, same caption:

| | length | what the vocal did |
|---|---|---|
| canvas hardcoded to the request | 180s | cut off; **never reached the outro**, looped two bridge lines from 3:16 |
| canvas from the model's own answer | **172s** | sang **all 399 words**, outro included, last word at 2:47, 5s tail |

Asked directly what length it wanted for that sheet, the encoder answered
`171.96` under a 180s ceiling and `162.28` under a 360s ceiling — a real opinion
about the song, not a passthrough of the ceiling.

## What this changes in the app

The app currently trims over-long lyric sheets on their way to the backend
(`enforceLength` in `public/js/pacing.js`, applied in the proxy) because a sheet
that outran the canvas was being truncated. Once the model sets the length that
guard is unnecessary — and worse than unnecessary, since it would cut verses the
model would happily have sung. The server watches for a song coming back shorter
than it asked for, takes that as the sign this fix is in, and stops trimming by
itself. Nothing to configure.
