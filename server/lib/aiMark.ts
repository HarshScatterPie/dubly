import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { serverRoot } from './paths';

/**
 * Every dub says it is AI-made, in three places (docs/AI-LABELLING.md):
 *
 * 1. A visible label in the picture, on plans with `visibleWatermark` (Free and Starter).
 * 2. The file's own metadata, on every plan: the tags any player or media tool lists.
 * 3. XMP inside the file, on every plan: the IPTC "digital source type" term that provenance tools look for, and the mark's id.
 *
 * Each render gets its own id, stored with the language it belongs to, so a file found elsewhere can be traced to its project.
 * 2 and 3 live in the file's wrapping, not in the picture or sound: re-encoding the video, as social platforms do, removes them.
 */
export const AI_LABEL_PATH = path.join(serverRoot, 'assets', 'watermark', 'dubbed-by-dubly.png');

// IPTC's term for media that mixes a real recording with AI-made parts: here, real picture with AI-made speech.
const DIGITAL_SOURCE_TYPE = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';
// The ISO base media "uuid" box type that holds XMP.
const XMP_BOX_ID = Buffer.from('BE7ACFCB97A942E89C71999491E3AFAC', 'hex');

export interface AiMark {
  id: string;
  /** Burn the "Dubbed by Dubly Studio" label into the picture. */
  visibleLabel: boolean;
}

export const newAiMark = (visibleLabel: boolean): AiMark => ({ id: randomUUID(), visibleLabel });

export const aiMarkStatement = (id: string) => `Dubbed by Dubly Studio. The speech in this video is AI-generated. Dubly mark ${id}`;

/** ffmpeg arguments for the file's metadata. ffmpeg carries these along when a later step (subtitles, captions) rewrites the file. */
export const aiMetadataArgs = (id: string): string[] => ['-metadata', `comment=${aiMarkStatement(id)}`, '-metadata', `description=${aiMarkStatement(id)}`];

export function aiMarkXmp(id: string): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
 xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
 Iptc4xmpExt:DigitalSourceType="${DIGITAL_SOURCE_TYPE}"
 xmp:CreatorTool="Dubly Studio"
 xmpMM:DocumentID="urn:uuid:${id}">
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${aiMarkStatement(id)}</rdf:li></rdf:Alt></dc:description>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="r"?>`;
}

/**
 * Adds the XMP as a top-level box at the end of an MP4. Players skip boxes they do not know, and nothing before it moves, so the file
 * still starts playing at once. It goes on last: a step that rewrites the file (subtitles, burned captions) drops it.
 */
export async function appendAiXmp(filePath: string, id: string): Promise<void> {
  const packet = Buffer.from(aiMarkXmp(id), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + XMP_BOX_ID.length + packet.length, 0);
  header.write('uuid', 4, 'latin1');
  await appendFile(filePath, Buffer.concat([header, XMP_BOX_ID, packet]));
}
