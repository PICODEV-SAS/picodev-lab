// hls.js 1.7.3, light build (Apache 2.0, LICENSE): the part of its API video.ts uses.
// ponytail: written by hand, not the package's 6 000-line hls.d.mts; extend it with what you call.
export interface HlsConfig {
  enableWorker?: boolean;
  lowLatencyMode?: boolean;
  xhrSetup?: (xhr: XMLHttpRequest, url: string) => void;
}
export default class Hls {
  static isSupported(): boolean;
  static readonly Events: { readonly ERROR: 'hlsError' };
  constructor(config?: HlsConfig);
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  on(event: 'hlsError', listener: (event: 'hlsError', data: { fatal: boolean }) => void): void;
  destroy(): void;
}
