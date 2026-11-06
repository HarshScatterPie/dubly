# AI labelling of dubbed videos

Every dub says it is AI-made. This page covers what Dubly puts in a video, what it does not yet do, and the rule behind it. It is an engineering summary, not legal advice.

## What a dub carries

| | Free, Starter | Enterprise |
|---|---|---|
| Visible "Dubbed by Dubly Studio" label, bottom right | Yes | No (`visibleWatermark: false`) |
| File metadata (`comment`, `description`): the statement and a unique id | Yes | Yes |
| XMP in the file: IPTC `DigitalSourceType` = `compositeWithTrainedAlgorithmicMedia`, `CreatorTool`, the id | Yes | Yes |

- **The id** is new for every render and stored on the project as `languageOutputs.<code>.aiMarkId`, so a copy found elsewhere can be traced to its project.
- **Where it applies:** the dubbed video and its captioned download (the label and tags carry over; the XMP is added again).
- **Changing a plan:** `visibleWatermark` is a field on the plan (`server/lib/plans.ts`, then the `plans` collection in MongoDB once stored). Set it to `true` on `enterprise` to show the label there; new renders follow within a minute.
- **The label's wording and look:** `server/scripts/render_watermark.mjs` writes `server/assets/watermark/dubbed-by-dubly.png`, which is committed.
- **Cost:** a labelled dub encodes the picture again (`veryfast`, CRF 20) instead of copying it. Measured on the office PC: about 16 s per minute of 1080p, per language. An unlabelled dub still copies the picture.

## Reading the mark

```bash
ffprobe -v error -show_entries format_tags -of json dubbed.mp4   # comment and description
exiftool -xmp:all dubbed.mp4                                     # the XMP
```

## What it does not do

- **Metadata does not survive re-encoding.** Uploading to a social platform, or any re-export, removes the tags and the XMP. Only the visible label stays, because it is in the picture.
- **AI chat tools do not read it.** Tools such as ChatGPT or Gemini look at the picture and sound, not the file's tags, so they will not report "Dubbed by Dubly Studio" from the metadata. A tool that reads metadata or XMP will.
- **No mark is hidden in the picture or the sound yet**, so an Enterprise dub that has been re-encoded carries no mark at all.
- **Audio-only downloads and Text-to-Voice clips carry no label.** The rule below asks for a spoken disclosure at the start of audio.
- **Dubs rendered before this change are not labelled.** A re-dub labels them.

## Next steps, strongest first

1. **Signed C2PA Content Credentials**: the industry standard, tamper-evident, read by Content Credentials tools. Needs the open-source `c2patool` on the server and a signing certificate. Like metadata, it is removed by re-encoding.
2. **A robust mark in the sound or picture**: survives re-encoding, read only by Dubly's own checker. Needs a measured choice of method, since the open models for this are on Hugging Face, which Dubly does not use.

## The rule

- **Which law:** the labelling duty is in the **IT Rules amendment of 10 February 2026 (G.S.R. 120(E))** on synthetically generated information. The **DPDP Act** covers personal data, not AI labels. It is a separate piece of work.
- **What it asks, per the notification's wording as quoted by secondary sources:** content must be "prominently labelled in a manner that ensures prominent visibility in the visual display" (for audio, "a prominently prefixed audio disclosure"), and "embedded with a permanent metadata or other appropriate technical provenance mechanisms", "to the extent technically feasible, including a unique identifier". Intermediaries must not let those be removed.
- **Open questions for a lawyer:**
  - Enterprise dubs have no visible label. Metadata is listed as an addition to the visible label, not a replacement for it.
  - Whether Dubly is an "intermediary" under the rule at all.
  - Whether dubbing falls under the exclusion for using a computer resource "solely for improving accessibility, clarity, quality, translation". AI voices that replace a speaker may go beyond that.
  - Whether "Dubbed by Dubly Studio" says enough without the words "AI" or "synthetic". The label's wording is one line in the script above.
