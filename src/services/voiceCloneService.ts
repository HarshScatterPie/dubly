/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CustomVoice, Voice } from '../types';
import { apiDelete, apiGet } from '../lib/apiClient';
import { auth } from '../lib/firebase';

export interface CloneEngines {
  chatterbox: boolean;
  indicf5: boolean;
}

export interface CustomVoiceList {
  voices: CustomVoice[];
  cloningAvailable: boolean;
  engines: CloneEngines;
}

export class VoiceCloneService {
  public list(): Promise<CustomVoiceList> {
    return apiGet<CustomVoiceList>('/api/voices');
  }

  /**
   * Registers a recording as a new voice. Multipart rather than JSON because the sample is
   * a blob, and the server transcribes it on the way in.
   */
  public async create(
    sample: Blob,
    meta: { name: string; gender: 'male' | 'female' | 'non-binary'; languageCode: string }
  ): Promise<CustomVoice> {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in');

    const form = new FormData();
    // Named with an extension so the server's file filter and ffmpeg both know what it is;
    // MediaRecorder gives webm/opus, a file picker gives whatever the user chose.
    const extension = sample instanceof File ? sample.name.split('.').pop() || 'webm' : 'webm';
    form.append('sample', sample, `sample.${extension}`);
    form.append('name', meta.name);
    form.append('gender', meta.gender);
    form.append('languageCode', meta.languageCode);

    const res = await fetch('/api/voices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await user.getIdToken()}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Could not save the voice (${res.status})`);
    }
    return res.json();
  }

  public delete(voiceId: string): Promise<void> {
    return apiDelete(`/api/voices/${encodeURIComponent(voiceId)}`);
  }

  /**
   * Shapes a cloned voice like a catalog voice, so the pickers can render both from one
   * list instead of maintaining a parallel code path for "your voices".
   */
  public toVoice(custom: CustomVoice): Voice {
    return {
      id: custom.id,
      name: custom.name,
      gender: custom.gender,
      languageCode: custom.languageCode,
      languageName: 'Your voice',
      accent: 'Cloned from your recording',
      category: 'conversational',
      description: 'A voice cloned from a recording you uploaded.',
      avatarUrl: '',
      sampleQuote: custom.sampleTranscript || 'This is my own voice, speaking a new language.',
      tags: ['Your voice', 'Cloned'],
      pitch: 1,
      speed: 1,
      provider: 'clone',
      providerVoice: { clone: custom.id },
    };
  }
}

export const voiceCloneService = new VoiceCloneService();
