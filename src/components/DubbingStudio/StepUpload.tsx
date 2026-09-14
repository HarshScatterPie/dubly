/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef } from 'react';
import {
  Upload,
  Video,
  FileVideo,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Play,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { SampleVideoPreset } from '../../types';
import { SAMPLE_VIDEOS } from '../../data/mockData';
import { VideoPlayer } from '../VideoPlayer';

interface StepUploadProps {
  selectedFile: File | null;
  videoPreviewUrl: string | null;
  fileName: string;
  fileSizeFormatted: string;
  durationFormatted: string;
  resolution: string;
  detectedAudio: string;
  detectedLanguage: string;
  isAnalyzing: boolean;
  isUploading?: boolean;
  onFileSelected: (file: File) => void;
  onSelectSample: (sample: SampleVideoPreset) => void;
  onAnalyzeVideo: () => void;
  onResetVideo: () => void;
}

export const StepUpload: React.FC<StepUploadProps> = ({
  selectedFile,
  videoPreviewUrl,
  fileName,
  fileSizeFormatted,
  durationFormatted,
  resolution,
  detectedAudio,
  detectedLanguage,
  isAnalyzing,
  isUploading = false,
  onFileSelected,
  onSelectSample,
  onAnalyzeVideo,
  onResetVideo,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('video/') || file.name.match(/\.(mp4|mov|webm)$/i)) {
        onFileSelected(file);
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelected(e.target.files[0]);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Upload Zone or Active Workspace */}
      {!videoPreviewUrl ? (
        <div className="space-y-6">
          {/* Big Dropzone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="relative group cursor-pointer overflow-hidden rounded-3xl glass-panel border-2 border-dashed border-[#E2E8F0] hover:border-[#F05637]/70 p-10 sm:p-16 text-center transition-all duration-200 hover:shadow-[0_0_30px_rgba(240,86,55,0.15)]"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={handleFileInputChange}
              className="hidden"
            />

            <div className="max-w-md mx-auto space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-[#F05637]/15 border border-[#F05637]/30 text-[#D94B2E] flex items-center justify-center mx-auto shadow-inner group-hover:scale-105 transition-transform">
                <Upload className="w-8 h-8" />
              </div>

              <div>
                <h3 className="text-xl sm:text-2xl font-bold text-[#0F172A] tracking-tight">
                  Drop your video here
                </h3>
                <p className="text-sm text-[#64748B] mt-1">
                  or <span className="text-[#D94B2E] underline font-medium">browse from your computer</span>
                </p>
              </div>

              <div className="pt-2 flex flex-wrap items-center justify-center gap-3 text-xs text-[#94A3B8] font-mono">
                <span className="px-2.5 py-1 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0]">MP4</span>
                <span className="px-2.5 py-1 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0]">MOV</span>
                <span className="px-2.5 py-1 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0]">WEBM</span>
                <span>• Up to 500 MB</span>
              </div>
            </div>
          </div>

          {/* Sample Video Drawer */}
          <div className="rounded-2xl glass-panel p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="text-sm font-bold text-[#0F172A] flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#F05637]" />
                  <span>Try a sample video</span>
                </h4>
                <p className="text-xs text-[#64748B]">
                  Don't have a video file ready? Test our full multi-lingual AI dubbing pipeline in seconds.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {SAMPLE_VIDEOS.map((sample) => (
                <div
                  key={sample.id}
                  onClick={() => onSelectSample(sample)}
                  className="group relative overflow-hidden rounded-xl bg-[#FFFFFF] hover:bg-[#F8FAFC] border border-[#E2E8F0] hover:border-[#F05637]/60 cursor-pointer p-3 transition-all"
                >
                  <div className="relative h-28 rounded-lg overflow-hidden mb-3 bg-black">
                    <img
                      src={sample.thumbnailUrl}
                      alt={sample.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <Play className="w-6 h-6 text-white fill-current opacity-90 group-hover:scale-110 transition-transform" />
                    </div>
                    <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-slate-200">
                      {sample.durationFormatted}
                    </span>
                  </div>

                  <h5 className="text-xs font-bold text-[#0F172A] group-hover:text-[#D94B2E] truncate">
                    {sample.title}
                  </h5>
                  <p className="text-[11px] text-[#64748B] line-clamp-2 mt-1">
                    {sample.description}
                  </p>
                  <div className="mt-2.5 pt-2 border-t border-[#E2E8F0] flex items-center justify-between text-[10px] text-[#94A3B8]">
                    <span className="text-[#D94B2E] font-semibold">{sample.detectedLanguage}</span>
                    <span>{sample.resolution.split(' ')[0]}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* Workspace when video is uploaded/selected */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left: Video Player */}
          <div className="lg:col-span-7 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
                Video Preview
              </span>
              <button
                type="button"
                onClick={onResetVideo}
                className="flex items-center gap-1.5 text-xs text-[#64748B] hover:text-rose-600 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Replace Video</span>
              </button>
            </div>
            <div className="relative rounded-2xl overflow-hidden border border-[#E2E8F0] shadow-2xl bg-[#FFFFFF]">
              <VideoPlayer
                src={videoPreviewUrl}
                className="w-full aspect-video"
              />
            </div>
          </div>

          {/* Right: Video Details & Analyze CTA */}
          <div className="lg:col-span-5 space-y-6">
            <div className="rounded-2xl glass-panel p-6 space-y-5">
              <div className="flex items-center justify-between pb-4 border-b border-[#E2E8F0]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#F05637]/20 text-[#D94B2E] flex items-center justify-center border border-[#F05637]/30">
                    <FileVideo className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-[#0F172A] truncate max-w-[180px]">
                      {fileName}
                    </h4>
                    <p className="text-xs text-[#64748B] font-mono">{fileSizeFormatted}</p>
                  </div>
                </div>
                {isUploading ? (
                  <span className="px-2.5 py-1 rounded-full bg-coral-50/80 text-coral-600 text-[10px] font-semibold border border-coral-200/60 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Uploading...
                  </span>
                ) : (
                  <span className="px-2.5 py-1 rounded-full bg-emerald-50/80 text-emerald-600 text-[10px] font-semibold border border-emerald-200/60 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    Valid Media
                  </span>
                )}
              </div>

              <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">
                Detected Video Details
              </h4>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#94A3B8] block text-[10px]">Source Language</span>
                  <span className="font-semibold text-[#0F172A] mt-0.5 block">
                    {detectedLanguage}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#94A3B8] block text-[10px]">Duration</span>
                  <span className="font-semibold text-[#0F172A] font-mono mt-0.5 block">
                    {durationFormatted}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#94A3B8] block text-[10px]">Audio Stream</span>
                  <span className="font-semibold text-emerald-600 mt-0.5 block truncate">
                    {detectedAudio}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0]">
                  <span className="text-[#94A3B8] block text-[10px]">Resolution</span>
                  <span className="font-semibold text-[#0F172A] font-mono mt-0.5 block">
                    {resolution}
                  </span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[#F05637]/10 border border-[#F05637]/30 text-xs text-[#0F172A] flex items-start gap-2.5">
                <Sparkles className="w-4 h-4 text-[#D94B2E] shrink-0 mt-0.5" />
                <p className="text-xs text-[#64748B]">
                  Dubly will analyze vocal cadence, extract high-resolution speech tokens, and separate background noise before transcription.
                </p>
              </div>

              <button
                type="button"
                onClick={onAnalyzeVideo}
                disabled={isAnalyzing || isUploading}
                className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-[#F05637] hover:bg-[#D94B2E] active:bg-[#B3391F] text-white font-semibold text-sm shadow-[0_0_20px_rgba(240,86,55,0.3)] transition-all duration-200 disabled:opacity-50"
              >
                {isUploading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Uploading video...</span>
                  </>
                ) : isAnalyzing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Analyzing Audio Tracks...</span>
                  </>
                ) : (
                  <>
                    <span>Analyze Video</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
