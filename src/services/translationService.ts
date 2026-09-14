/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DubbingProject, TranslationStyle } from '../types';
import { projectService } from './projectService';

export class TranslationService {
  /**
   * Translates the project's transcript into every language in `targetLangCodes` (Vertex
   * Gemini / OpenAI / Sarvam, routed server-side per language + user provider preference).
   */
  public async translateSegments(
    projectId: string,
    targetLangCodes: string[],
    style: TranslationStyle = 'natural',
    adaptExpressions: boolean = true,
    regenerate: boolean = false
  ): Promise<DubbingProject> {
    return projectService.translate(projectId, targetLangCodes, style, adaptExpressions, regenerate);
  }
}

export const translationService = new TranslationService();
