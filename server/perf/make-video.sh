#!/usr/bin/env bash
# Makes the release gate's test video: a two-voice spoken dialogue (espeak-ng) twice through, over a quiet music bed,
# 848x478 like a typical upload, about 3 minutes. Usage: server/perf/make-video.sh <out.mp4>   (needs espeak-ng)
set -euo pipefail

OUT="${1:?usage: make-video.sh <out.mp4>}"
FFMPEG="${FFMPEG:-$(node -p "require('ffmpeg-static')")}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

lines=(
  "Hello everyone, and welcome back to our weekly cooking show."
  "Thanks for having me. I am really excited about today's recipe."
  "Today we are making a simple vegetable curry that anyone can cook at home."
  "It is one of my favourite dishes. My grandmother used to make it every Sunday."
  "First, let us wash the vegetables and cut them into small pieces."
  "Should I peel the potatoes, or keep the skin on?"
  "Keep the skin on. It adds flavour, and it saves a lot of time."
  "Great. Now what goes into the pan first?"
  "Heat two spoons of oil, then add cumin seeds and wait until they crackle."
  "I can already smell it. That is wonderful."
  "Now add the chopped onions and cook them until they turn golden brown."
  "How long does that usually take?"
  "About eight minutes on medium heat. Please be patient, this step matters."
  "Next come ginger, garlic, turmeric, and a little red chilli powder."
  "Mix everything well and let the spices cook for two minutes."
  "Then we add the vegetables and one cup of water, right?"
  "Exactly. Cover the pan and let it simmer for fifteen minutes."
  "While we wait, can you tell us how to make it less spicy for children?"
  "Just skip the chilli powder and add a spoon of fresh cream at the end."
  "That is a brilliant tip. My kids will love that."
  "Finally, sprinkle fresh coriander leaves and serve it hot with rice."
  "It looks delicious. Thank you so much for sharing this recipe."
  "If you enjoyed this video, please like it and share it with your friends."
  "See you all next week with another easy recipe. Goodbye!"
)

"$FFMPEG" -loglevel error -f lavfi -t 0.7 -i anullsrc=r=22050:cl=mono -c:a pcm_s16le "$WORK/gap.wav"
: > "$WORK/list.txt"
for i in "${!lines[@]}"; do
  voice=$([ $((i % 2)) -eq 0 ] && echo en-us+m3 || echo en-us+f3)
  espeak-ng -v "$voice" -s 150 -w "$WORK/line_$i.wav" "${lines[$i]}"
  printf "file 'line_%s.wav'\nfile 'gap.wav'\n" "$i" >> "$WORK/list.txt"
done
"$FFMPEG" -loglevel error -f concat -safe 0 -i "$WORK/list.txt" -ar 48000 -ac 1 "$WORK/dialog.wav"
"$FFMPEG" -loglevel error -stream_loop 1 -i "$WORK/dialog.wav" -c copy "$WORK/dialog2.wav"
"$FFMPEG" -loglevel error -y -i "$WORK/dialog2.wav" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000" -f lavfi -i "sine=frequency=330:sample_rate=48000" -f lavfi -i "testsrc2=size=848x478:rate=25" \
  -filter_complex "[1][2]amix=inputs=2,volume=0.03[m];[0][m]amix=inputs=2:duration=first:normalize=0[a]" \
  -map 3:v -map "[a]" -shortest -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 "$OUT"
echo "made $OUT"
